param(
    [Parameter(Mandatory = $true)][string]$Serial
)

$ErrorActionPreference = 'Stop'
$originalLocation = Get-Location
try {
    Set-Location -LiteralPath $PSScriptRoot
    if ((& adb -s $Serial get-state) -ne 'device') {
        throw 'Conecta y autoriza el teléfono físico seleccionado.'
    }

    # Flutter's integration runner remembers the APK package before building
    # and uninstalls it on exit. Prebuild and verify the isolated package first.
    & flutter build apk --debug --no-pub --target integration_test/import_refresh_test.dart --dart-define=MAILGASTO_ANDROID_AUDIT=true
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo compilar el APK aislado.' }

    $sdk = $env:ANDROID_SDK_ROOT
    if (-not $sdk) { $sdk = $env:ANDROID_HOME }
    if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
    $aapt = Get-ChildItem -LiteralPath (Join-Path $sdk 'build-tools') -Directory |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName 'aapt.exe' } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
    if (-not $aapt) { throw 'No se encontró aapt para verificar el paquete de prueba.' }
    $badging = & $aapt dump badging 'build/app/outputs/flutter-apk/app-debug.apk'
    if ($LASTEXITCODE -ne 0 -or
        -not ($badging -match "^package: name='co\.com\.styleplus\.mailgasto\.audit' ")) {
        throw 'El APK no está aislado; se canceló la prueba para conservar la app principal.'
    }
    & flutter test --no-pub integration_test/import_refresh_test.dart -d $Serial --dart-define=MAILGASTO_ANDROID_AUDIT=true
    if ($LASTEXITCODE -ne 0) { throw 'Falló la validación Android aislada.' }
} finally {
    Set-Location -LiteralPath $originalLocation
}
