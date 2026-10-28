Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Review-only library. No side effect until the fixed function is invoked in the
# disposable hosted runner. No arbitrary scriptblock/module/URL enters this API.
function Invoke-HpmN09HostedExecution {
    param(
        [Parameter(Mandatory)][string]$OwnedRoot,
        [Parameter(Mandatory)][ValidatePattern('\A[a-f0-9]{64}\z')][string]$ReviewPlanSha256,
        [Parameter(Mandatory)][ValidatePattern('\A[a-f0-9]{64}\z')][string]$BuildReceiptSha256,
        [ValidateSet('original', 'sending-ack', 'finished-ack', 'withdrawn-ack', 'uncertain-ack', 'sending-commit', 'finished-commit', 'withdrawn-commit', 'uncertain-commit')][string]$PublicationGroup = 'original'
    )
    $state = @{ invoked = $false; closed = $false; stage = 'review_plan' }
    try {
        if ($PublicationGroup -cnotin @('original', 'sending-ack', 'finished-ack', 'withdrawn-ack', 'uncertain-ack', 'sending-commit', 'finished-commit', 'withdrawn-commit', 'uncertain-commit')) { throw 'invalid' }
        $OwnedRoot = [IO.Path]::GetFullPath($OwnedRoot)
        $reviewFile = Join-Path $OwnedRoot 'n09-hosted-review-plan.json'
        if ((Get-Item -LiteralPath $reviewFile).Length -gt 131072 -or
            (Get-FileHash -LiteralPath $reviewFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ReviewPlanSha256) { throw 'invalid' }
        $review = [IO.File]::ReadAllText($reviewFile, [Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json -AsHashtable
        $expected = @('candidate', 'manifestSha256', 'lifecyclePins', 'controllerPins', 'loadedPins', 'negativeAddress', 'jobSourcePins', 'libraryPins')
        if ($PublicationGroup -cne 'original') { $expected += 'publicationGroup'; if ($review.publicationGroup -cne $PublicationGroup) { throw 'invalid' } }
        if ($review.Count -ne $expected.Count -or @($expected | Where-Object { -not $review.ContainsKey($_) }).Count -ne 0) { throw 'invalid' }
        $state.stage = 'library_pins'
        $network = Join-Path $PSScriptRoot '../shared/hosted-network.ps1'
        $materials = Join-Path $PSScriptRoot '../shared/hosted-materials.ps1'
        $wfp = Join-Path $PSScriptRoot '../shared/hosted-egress-wfp.cs'
        $job = Join-Path $PSScriptRoot 'owned-job.ps1'
        foreach ($file in @($network, $materials, $wfp, $job)) {
            $file = [IO.Path]::GetFullPath($file)
            if (-not $review.libraryPins.ContainsKey($file) -or $review.libraryPins[$file] -cnotmatch '\A[a-f0-9]{64}\z' -or
                (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $review.libraryPins[$file]) { throw 'invalid' }
        }
        $state.stage = 'load_libraries'
        . $network
        . $job
        # GetNewClosure creates a dynamic module: retain the verified local
        # function explicitly instead of resolving its name from that module.
        $ownedScenario = Get-Command Invoke-HpmN09OwnedScenario -CommandType Function -ErrorAction Stop
        $run = {
            param($networkDescriptor)
            if ($state.invoked) { throw 'n09_hosted_execution_rejected' }
            $state.invoked = $true
            $state.stage = 'network_descriptor'
            if ($networkDescriptor.node -cne (Join-Path $OwnedRoot 'payload/runtime/node/node.exe') -or
                $networkDescriptor.networkRoot -cne (Join-Path $OwnedRoot 'n08-hosted-network') -or
                $networkDescriptor.manifestSha256 -cne $review.manifestSha256) { throw 'n09_hosted_execution_rejected' }
            $plan = [ordered]@{ candidate = $review.candidate; ownedRoot = $OwnedRoot; manifestSha256 = $review.manifestSha256;
                lifecyclePins = $review.lifecyclePins;
                controllerPins = $review.controllerPins; loadedPins = $review.loadedPins; networkRoot = $networkDescriptor.networkRoot;
                caSha256 = $networkDescriptor.caSha256; leafSha256 = $networkDescriptor.leafSha256; negativeAddress = $review.negativeAddress }
            if ($PublicationGroup -cne 'original') { $plan.publicationGroup = $PublicationGroup }
            $state.stage = 'write_owned_plan'
            $planPath = Join-Path $OwnedRoot 'n09-hosted-plan.json'
            $planBytes = [Text.UTF8Encoding]::new($false).GetBytes(($plan | ConvertTo-Json -Depth 8 -Compress))
            $file = [IO.File]::Open($planPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $file.Write($planBytes); $file.Flush($true) } finally { $file.Dispose() }
            $planHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($planBytes)).ToLowerInvariant()
            $state.stage = 'owned_job'
            $result = & $ownedScenario -OwnedRoot $OwnedRoot -Candidate $review.candidate -PlanSha256 $planHash -SourcePins $review.jobSourcePins -PublicationGroup $PublicationGroup
            # Original Job helper and fixed result parser have both succeeded.
            $state.closed = $result.ownedTreeEmpty -eq $true
            return $result
        }.GetNewClosure()
        $stop = { return $state.invoked -and $state.closed }.GetNewClosure()
        $state.stage = 'hosted_network'
        return Invoke-HpmN08HostedNetwork -OwnedRoot $OwnedRoot -BuildReceiptSha256 $BuildReceiptSha256 -RunOwnedScenario $run -StopOwnedScenario $stop
    } catch {
        Write-Information ('hpm_n09_execution_failed_stage=' + $state.stage) -InformationAction Continue
        throw 'n09_hosted_execution_rejected'
    }
}
