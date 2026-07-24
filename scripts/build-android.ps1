param(
    [switch]$SkipLint
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$androidRoot = Join-Path $repoRoot 'android'
$toolsRoot = Join-Path $repoRoot '.tools'
$sdkRoot = Join-Path $toolsRoot 'android-sdk'
$javaHome = 'C:\Program Files\Java\jdk-17'
$signingFile = Join-Path $toolsRoot 'android-signing.properties'
$keystoreFile = Join-Path $toolsRoot 'fieldmaster-release.p12'
$outputDirectory = Join-Path $repoRoot 'public\downloads'
$outputApk = Join-Path $outputDirectory 'Fieldmaster-android.apk'
$versionMetadataFile = Join-Path $outputDirectory 'android-version.json'

if (-not (Test-Path (Join-Path $javaHome 'bin\java.exe'))) {
    throw "Brak JDK 17 w $javaHome."
}
if (-not (Test-Path (Join-Path $sdkRoot 'platforms\android-36\android.jar'))) {
    throw "Brak Android SDK 36 w $sdkRoot. Zainstaluj platforms;android-36 i build-tools;36.0.0."
}

$env:JAVA_HOME = $javaHome
$env:ANDROID_SDK_ROOT = $sdkRoot

if (-not (Test-Path $signingFile) -or -not (Test-Path $keystoreFile)) {
    New-Item -ItemType Directory -Force -Path $toolsRoot | Out-Null
    $bytes = New-Object byte[] 24
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    $password = ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
    $keytool = Join-Path $javaHome 'bin\keytool.exe'
    & $keytool `
        -genkeypair `
        -keystore $keystoreFile `
        -storetype PKCS12 `
        -storepass $password `
        -keypass $password `
        -alias fieldmaster `
        -keyalg RSA `
        -keysize 4096 `
        -validity 9125 `
        -dname 'CN=Fieldmaster, OU=Mobile, O=Fieldmaster, L=Warsaw, C=PL'
    if ($LASTEXITCODE -ne 0) { throw 'Nie udalo sie utworzyc klucza podpisu APK.' }
    $signingLines = @(
        "storeFile=$($keystoreFile.Replace('\','/'))"
        "storePassword=$password"
        'keyAlias=fieldmaster'
        "keyPassword=$password"
    )
    [System.IO.File]::WriteAllLines($signingFile, $signingLines, [System.Text.Encoding]::ASCII)
}

$tasks = @('clean')
if (-not $SkipLint) { $tasks += 'lintRelease' }
$tasks += 'assembleRelease'

Push-Location $androidRoot
try {
    & '.\gradlew.bat' --no-daemon @tasks
    if ($LASTEXITCODE -ne 0) { throw "Gradle zakonczyl sie kodem $LASTEXITCODE." }
} finally {
    Pop-Location
}

$builtApk = Join-Path $androidRoot 'app\build\outputs\apk\release\app-release.apk'
if (-not (Test-Path $builtApk)) { throw "Nie znaleziono zbudowanego APK: $builtApk" }
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
Copy-Item -LiteralPath $builtApk -Destination $outputApk -Force

$apksigner = Join-Path $sdkRoot 'build-tools\36.0.0\apksigner.bat'
& $apksigner verify --verbose $outputApk
if ($LASTEXITCODE -ne 0) { throw 'Weryfikacja podpisu APK nie powiodla sie.' }

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputApk).Hash.ToLowerInvariant()
$size = (Get-Item -LiteralPath $outputApk).Length
$gradleConfig = Get-Content -LiteralPath (Join-Path $androidRoot 'app\build.gradle.kts') -Raw
$versionCodeMatch = [regex]::Match($gradleConfig, 'versionCode\s*=\s*(\d+)')
$versionNameMatch = [regex]::Match($gradleConfig, 'versionName\s*=\s*"([^"]+)"')
if (-not $versionCodeMatch.Success -or -not $versionNameMatch.Success) {
    throw 'Nie odczytano versionCode lub versionName z app/build.gradle.kts.'
}
$versionMetadata = [ordered]@{
    versionCode = [int]$versionCodeMatch.Groups[1].Value
    versionName = $versionNameMatch.Groups[1].Value
    apkUrl = 'https://fieldmaster-t8t4.onrender.com/downloads/Fieldmaster-android.apk'
    sha256 = $hash
    size = $size
    publishedAt = [DateTime]::UtcNow.ToString('o')
}
$versionJson = $versionMetadata | ConvertTo-Json
[System.IO.File]::WriteAllText(
    $versionMetadataFile,
    $versionJson + [Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false)
)
Write-Output "APK=$outputApk"
Write-Output "SIZE=$size"
Write-Output "SHA256=$hash"
Write-Output "VERSION=$($versionMetadata.versionName) ($($versionMetadata.versionCode))"
Write-Output "METADATA=$versionMetadataFile"
Write-Output "UWAGA: zachowaj katalog .tools - zawiera prywatny klucz wymagany do przyszlych aktualizacji APK."
