'use strict';
function shouldConvertResponsesToOpenAIChat(profile) {
  if (!profile) return false;
  return (
    profile.forceChatCompletions === true ||
    profile.supportsResponses === false ||
    profile.responsesMode === 'chat' ||
    profile.responsesEndpoint === 'chat' ||
    profile.protocol === 'openai-chat' ||
    profile.protocol === 'workbuddy'
  );
}
module.exports = { shouldConvertResponsesToOpenAIChat };
