use std::sync::OnceLock;
use std::time::Duration;
use tauri::menu::{
    CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::tray::TrayIconId;
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::management_bridge::perform_management_request;
use crate::proxy_root::find_project_root;
use crate::{get_management_token_native, proxy_config_value, proxy_management_port};

static ACTIVE_TRAY_ID: OnceLock<TrayIconId> = OnceLock::new();
const MAX_TRAY_ROUTES_PER_AGENT: usize = 12;

pub(crate) fn remember_tray_id(id: TrayIconId) {
    let _ = ACTIVE_TRAY_ID.set(id);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TrayProfileEntry {
    pub id: String,
    pub name: String,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TrayRouteChoice {
    pub profile_id: String,
    pub model: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TrayDynamicAction {
    SwitchProfile(String),
    BindAgent {
        agent: String,
        profile_id: String,
        model: String,
    },
    ClearCooldowns,
    RefreshMenu,
}

fn infer_default_model_for_tray_profile(item: &serde_json::Value) -> &'static str {
    let url = item
        .get("targetUrl")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let id = item
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let protocol = item
        .get("protocol")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if url.contains("kimi.com/coding") || id.contains("kimi-coding") {
        "kimi-for-coding"
    } else if url.contains("moonshot.cn") || id.contains("kimi") {
        "kimi-k2-0905-preview"
    } else if url.contains("deepseek.com") || id.contains("deepseek") {
        "deepseek-chat"
    } else if url.contains("bigmodel.cn") || id.contains("glm") {
        "glm-5.1"
    } else if url.contains("dashscope.aliyuncs.com") || id.contains("qwen") || id.contains("dashscope") {
        "qwen3-coder-plus"
    } else if url.contains("minimaxi.com") || id.contains("minimax") {
        "MiniMax-M2.7"
    } else if url.contains("siliconflow.cn") {
        "deepseek-ai/DeepSeek-V3"
    } else if protocol == "claude" {
        "claude-sonnet-4-6"
    } else if protocol == "gemini" {
        "gemini-2.5-pro"
    } else {
        "gpt-5.4"
    }
}

pub(crate) fn extract_tray_profiles_and_routes(
    config: Option<&serde_json::Value>,
) -> (Vec<TrayProfileEntry>, Vec<TrayRouteChoice>) {
    let Some(cfg) = config else {
        return (Vec::new(), Vec::new());
    };
    let active_profile = cfg
        .get("activeProfile")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();

    let mut profiles = Vec::new();
    if let Some(arr) = cfg.get("profiles").and_then(|v| v.as_array()) {
        for item in arr {
            let id = item
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .trim();
            if id.is_empty() {
                continue;
            }
            let name = item
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(id)
                .trim();
            profiles.push(TrayProfileEntry {
                id: id.to_string(),
                name: if name.is_empty() {
                    id.to_string()
                } else {
                    name.to_string()
                },
                active: id == active_profile,
            });
        }
    }

    let mut routes = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if let Some(arr) = cfg.get("modelRoutes").and_then(|v| v.as_array()) {
        for route in arr {
            if route.get("enabled").and_then(|v| v.as_bool()) == Some(false) {
                continue;
            }
            let from = route
                .get("from")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .trim();
            let profile_id = route
                .get("profileId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .trim();
            let to = route
                .get("to")
                .and_then(|v| v.as_str())
                .unwrap_or(from)
                .trim();
            if from.is_empty() || from == "*" || profile_id.is_empty() {
                continue;
            }
            let _target_model = if to.is_empty() || to == "*" { from } else { to };
            let dedup_key = format!("{profile_id}::{from}");
            if !seen.insert(dedup_key) {
                continue;
            }
            let label = format!("{from}  ->  {profile_id}");
            routes.push(TrayRouteChoice {
                profile_id: profile_id.to_string(),
                model: from.to_string(),
                label,
            });
            if routes.len() >= MAX_TRAY_ROUTES_PER_AGENT {
                break;
            }
        }
    }

    if let Some(arr) = cfg.get("profiles").and_then(|v| v.as_array()) {
        for item in arr {
            if routes.len() >= MAX_TRAY_ROUTES_PER_AGENT {
                break;
            }
            let profile_id = item
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .trim();
            if profile_id.is_empty() {
                continue;
            }
            if routes.iter().any(|r| r.profile_id == profile_id) {
                continue;
            }
            let default_model = infer_default_model_for_tray_profile(item);
            let dedup_key = format!("{profile_id}::{default_model}");
            if !seen.insert(dedup_key) {
                continue;
            }
            routes.push(TrayRouteChoice {
                profile_id: profile_id.to_string(),
                model: default_model.to_string(),
                label: format!("{default_model}  ->  {profile_id}"),
            });
        }
    }

    (profiles, routes)
}

pub(crate) fn parse_tray_action(menu_id: &str) -> Option<TrayDynamicAction> {
    if menu_id == "tray_refresh" {
        return Some(TrayDynamicAction::RefreshMenu);
    }
    if menu_id == "tray_clear_cooldowns" {
        return Some(TrayDynamicAction::ClearCooldowns);
    }
    if let Some(profile_id) = menu_id.strip_prefix("tray_profile:") {
        let trimmed = profile_id.trim();
        if !trimmed.is_empty() {
            return Some(TrayDynamicAction::SwitchProfile(trimmed.to_string()));
        }
    }
    if let Some(rest) = menu_id.strip_prefix("tray_bind:") {
        let mut parts = rest.splitn(3, ':');
        let agent = parts.next().unwrap_or_default().trim();
        let profile_id = parts.next().unwrap_or_default().trim();
        let model = parts.next().unwrap_or_default().trim();
        if !agent.is_empty() && !profile_id.is_empty() && !model.is_empty() {
            return Some(TrayDynamicAction::BindAgent {
                agent: agent.to_string(),
                profile_id: profile_id.to_string(),
                model: model.to_string(),
            });
        }
    }
    None
}

pub(crate) fn build_tray_menu(app: &AppHandle) -> Result<Menu<Wry>, tauri::Error> {
    let config = proxy_config_value();
    let (profiles, routes) = extract_tray_profiles_and_routes(config.as_ref());

    let show_item = MenuItemBuilder::new("显示主窗口")
        .id("tray_show")
        .build(app)?;

    let mut profile_submenu_builder = SubmenuBuilder::new(app, "切换默认上游 (Profile)");
    let mut profile_items = Vec::new();
    for entry in &profiles {
        let label = if entry.name == entry.id {
            entry.id.clone()
        } else {
            format!("{} ({})", entry.name, entry.id)
        };
        let item = CheckMenuItemBuilder::new(label)
            .id(format!("tray_profile:{}", entry.id))
            .checked(entry.active)
            .build(app)?;
        profile_items.push(item);
    }
    for item in &profile_items {
        profile_submenu_builder = profile_submenu_builder.item(item);
    }
    if profile_items.is_empty() {
        let empty = MenuItemBuilder::new("暂无已配置 Profile")
            .enabled(false)
            .build(app)?;
        profile_submenu_builder = profile_submenu_builder.item(&empty);
    }
    let profile_submenu = profile_submenu_builder.build()?;

    let agents = [
        ("claude-code", "Claude Code"),
        ("codex", "Codex CLI"),
        ("antigravity-cli", "Antigravity CLI"),
        ("gemini-cli", "Gemini CLI"),
        ("opencode", "OpenCode"),
        ("aider", "Aider"),
    ];
    let mut agent_submenus = Vec::new();
    for (agent_id, agent_label) in agents {
        let mut sub_builder = SubmenuBuilder::new(app, agent_label);
        let mut items = Vec::new();
        for choice in &routes {
            let item = MenuItemBuilder::new(&choice.label)
                .id(format!(
                    "tray_bind:{}:{}:{}",
                    agent_id, choice.profile_id, choice.model
                ))
                .build(app)?;
            items.push(item);
        }
        for item in &items {
            sub_builder = sub_builder.item(item);
        }
        if items.is_empty() {
            let empty = MenuItemBuilder::new("暂无模型路由")
                .enabled(false)
                .build(app)?;
            sub_builder = sub_builder.item(&empty);
        }
        agent_submenus.push(sub_builder.build()?);
    }

    let mut agents_root_builder = SubmenuBuilder::new(app, "快速切换 Agent 模型");
    for sub in &agent_submenus {
        agents_root_builder = agents_root_builder.item(sub);
    }
    let agents_submenu = agents_root_builder.build()?;

    let start_item = MenuItemBuilder::new("启动代理")
        .id("tray_start")
        .accelerator("CmdOrCtrl+Alt+S")
        .build(app)?;
    let stop_item = MenuItemBuilder::new("停止代理")
        .id("tray_stop")
        .accelerator("CmdOrCtrl+Alt+X")
        .build(app)?;
    let restart_item = MenuItemBuilder::new("重启代理")
        .id("tray_restart")
        .accelerator("CmdOrCtrl+Alt+R")
        .build(app)?;
    let status_item = MenuItemBuilder::new("查看状态")
        .id("tray_status")
        .build(app)?;
    let clear_cooldowns_item = MenuItemBuilder::new("⚡ 一键解除限流冷却")
        .id("tray_clear_cooldowns")
        .build(app)?;
    let refresh_item = MenuItemBuilder::new("刷新托盘列表")
        .id("tray_refresh")
        .build(app)?;
    let quit_item = MenuItemBuilder::new("退出").id("tray_quit").build(app)?;

    MenuBuilder::new(app)
        .items(&[
            &show_item,
            &PredefinedMenuItem::separator(app)?,
            &profile_submenu,
            &agents_submenu,
            &PredefinedMenuItem::separator(app)?,
            &start_item,
            &stop_item,
            &restart_item,
            &PredefinedMenuItem::separator(app)?,
            &status_item,
            &clear_cooldowns_item,
            &refresh_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ])
        .build()
}

pub(crate) fn update_tray_menu(app: &AppHandle) {
    let Some(tray_id) = ACTIVE_TRAY_ID.get() else {
        return;
    };
    if let Some(tray) = app.tray_by_id(tray_id) {
        if let Ok(menu) = build_tray_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

#[tauri::command]
pub(crate) fn refresh_tray_menu(app: AppHandle) {
    update_tray_menu(&app);
}

fn post_local_management_with_fallback(path: &str, payload: &serde_json::Value) -> bool {
    let port = proxy_management_port();
    let token_val = get_management_token_native(Some(port));
    let Some(token) = token_val
        .get("token")
        .and_then(|v| v.as_str())
        .filter(|_| token_val.get("ok").and_then(|v| v.as_bool()) == Some(true))
    else {
        return false;
    };
    let body = payload.to_string();
    perform_management_request(
        port,
        path,
        "POST",
        "application/json",
        &body,
        token,
        Duration::from_secs(4),
    )
    .map(|res| (200..300).contains(&res.status))
    .unwrap_or(false)
}

fn switch_active_profile_in_config_file(profile_id: &str) -> bool {
    let Some(root) = find_project_root() else {
        return false;
    };
    let config_path = root.join("proxy.config.json");
    let Ok(content) = std::fs::read_to_string(&config_path) else {
        return false;
    };
    let Ok(mut json) = serde_json::from_str::<serde_json::Value>(&content) else {
        return false;
    };
    json["activeProfile"] = serde_json::Value::String(profile_id.to_string());
    if let Ok(serialized) = serde_json::to_string_pretty(&json) {
        std::fs::write(&config_path, serialized).is_ok()
    } else {
        false
    }
}

pub(crate) fn handle_tray_dynamic_action(app_handle: &AppHandle, action: TrayDynamicAction) {
    let app = app_handle.clone();
    std::thread::spawn(move || match action {
        TrayDynamicAction::RefreshMenu => {
            update_tray_menu(&app);
        }
        TrayDynamicAction::ClearCooldowns => {
            let ok = post_local_management_with_fallback(
                "/v1/local/cooldowns/clear",
                &serde_json::json!({}),
            );
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit(
                    "tray-command",
                    serde_json::json!({
                        "command": "clear-cooldowns",
                        "code": if ok { 0 } else { 1 },
                        "output": if ok {
                            "已解除所有上游与 Key 池的限流冷却状态"
                        } else {
                            "解除限流冷却失败（请确认代理正在运行）"
                        },
                        "ok": ok
                    }),
                );
            }
        }
        TrayDynamicAction::SwitchProfile(profile_id) => {
            let payload = serde_json::json!({ "profileId": profile_id });
            let ok = if post_local_management_with_fallback("/v1/local/active", &payload) {
                true
            } else {
                switch_active_profile_in_config_file(&profile_id)
            };
            update_tray_menu(&app);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit(
                    "tray-command",
                    serde_json::json!({
                        "command": "switch-profile",
                        "profileId": profile_id,
                        "code": if ok { 0 } else { 1 },
                        "output": format!("已从托盘切换默认上游为: {profile_id}"),
                        "ok": ok
                    }),
                );
            }
        }
        TrayDynamicAction::BindAgent {
            agent,
            profile_id,
            model,
        } => {
            let payload = serde_json::json!({
                "agent": agent,
                "profileId": profile_id,
                "model": model
            });
            let ok = post_local_management_with_fallback("/v1/local/agents/bind", &payload);
            update_tray_menu(&app);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit(
                    "tray-command",
                    serde_json::json!({
                        "command": "bind-agent",
                        "agent": agent,
                        "profileId": profile_id,
                        "model": model,
                        "code": if ok { 0 } else { 1 },
                        "output": format!("已从托盘将 {agent} 绑定到 {profile_id} ({model})"),
                        "ok": ok
                    }),
                );
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{extract_tray_profiles_and_routes, parse_tray_action, TrayDynamicAction};

    #[test]
    fn parses_tray_actions_accurately() {
        assert_eq!(
            parse_tray_action("tray_refresh"),
            Some(TrayDynamicAction::RefreshMenu)
        );
        assert_eq!(
            parse_tray_action("tray_clear_cooldowns"),
            Some(TrayDynamicAction::ClearCooldowns)
        );
        assert_eq!(
            parse_tray_action("tray_profile:deepseek"),
            Some(TrayDynamicAction::SwitchProfile("deepseek".to_string()))
        );
        assert_eq!(
            parse_tray_action("tray_bind:claude-code:kimi:kimi-for-coding"),
            Some(TrayDynamicAction::BindAgent {
                agent: "claude-code".to_string(),
                profile_id: "kimi".to_string(),
                model: "kimi-for-coding".to_string(),
            })
        );
        assert_eq!(parse_tray_action("tray_show"), None);
    }

    #[test]
    fn extracts_profiles_and_routes_from_config_json() {
        let cfg = serde_json::json!({
            "activeProfile": "deepseek",
            "profiles": [
                { "id": "deepseek", "name": "DeepSeek", "targetUrl": "https://api.deepseek.com" },
                { "id": "kimi-coding", "name": "Kimi Coding", "targetUrl": "https://api.kimi.com/coding/" }
            ],
            "modelRoutes": [
                { "from": "deepseek-chat", "profileId": "deepseek", "to": "deepseek-chat" },
                { "from": "*", "profileId": "deepseek", "to": "*" }
            ]
        });
        let (profiles, routes) = extract_tray_profiles_and_routes(Some(&cfg));
        assert_eq!(profiles.len(), 2);
        assert!(profiles[0].active);
        assert!(!profiles[1].active);
        assert_eq!(routes.len(), 2);
        assert_eq!(routes[0].model, "deepseek-chat");
        assert_eq!(routes[1].profile_id, "kimi-coding");
        assert_eq!(routes[1].model, "kimi-for-coding");
    }
}
