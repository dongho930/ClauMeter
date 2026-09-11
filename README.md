# 클로미터 (ClauMeter)

Claude Code의 5시간/주간 사용량 한도를 실시간으로 보여주는 Windows·macOS 데스크톱 위젯입니다.

**다운로드 → https://claumeter-web.skysky930.workers.dev**

- Anthropic 서버가 직접 계산한 **실측 사용률**만 표시합니다.
- 5시간·주간 게이지, 임계값(75%/90%) 색상 경고
- 각 게이지 아래에 "○시간 ○분 후 초기화" 카운트다운
- 과거 패턴을 학습해 "이 페이스면 구간 끝에 몇 %까지 갈지" 예측하는 AI 조언
- 50%/75%/90% 도달 시 데스크톱 알림 (같은 구간에서 중복으로 뜨지 않음)
- 자동 업데이트 (Windows는 자동 설치, macOS는 새 버전 알림)
- 한국어/영어/스페인어/프랑스어/독일어/포르투갈어/일본어/중국어/러시아어/이탈리아어/네덜란드어/폴란드어 12개 언어 지원

## 시스템 요구 사항

- Windows 10 또는 Windows 11
- macOS 10.15 Catalina 이상 (Apple Silicon·Intel 모두 지원)
- Claude Code CLI가 설치되어 있고 사용 중이어야 합니다
- Node.js를 따로 설치할 필요는 없습니다 - 클로미터에 들어 있는 실행 파일이 직접 처리합니다
- API 키 입력은 필요 없습니다

## 설치 (Windows)

1. [다운로드 페이지](https://claumeter-web.skysky930.workers.dev)에서 설치 파일을 받아 실행합니다.
   [Releases](../../releases)에서 직접 받으셔도 됩니다 - 파일 이름은 `ClauMeter.Setup.<버전>.exe`입니다.
2. 설치 후 처음 실행하면 위젯이 화면 하단에 뜨고, `~/.claude/settings.json`의 statusLine 훅이 **자동으로 등록**됩니다
   (아래 참고). 이후 Claude Code 터미널을 한 번 열어서 아무 메시지나 보내면 위젯에 실제 수치가 뜨기 시작합니다.
   그 전까지는 "데이터 없음"으로 보이는 게 정상입니다.

### "Windows의 PC 보호" 경고가 뜬다면

클로미터는 코드 서명이 되어 있지 않아서 SmartScreen이 파란 경고창을 띄웁니다. **추가 정보**를 누른 뒤
**실행**을 선택하면 됩니다. 서명 인증서는 매년 갱신 비용이 들어가서 무료 도구가 계속 감당하기엔 부담이 큽니다.

대신 설치 파일의 해시를 공개합니다. 릴리스에 함께 올라가는 `SHA256SUMS.txt`의 값과 PowerShell에서 계산한 값이
같은지 확인하실 수 있습니다:

```powershell
Get-FileHash .\ClauMeter.Setup.<버전>.exe -Algorithm SHA256
```

1.0.0은 `SHA256SUMS.txt` 없이 배포되었고, 해시는 다음과 같습니다:

```
7e743707378f2c98897ed7de7cba486abf70e5f02b415b08ff1893b9d867183d  ClauMeter.Setup.1.0.0.exe
```

## 설치 (macOS)

1. [Releases](../../releases)에서 `ClauMeter-<버전>-universal.dmg`를 받습니다 (Apple Silicon·Intel 공용).
2. DMG를 열고 **ClauMeter를 응용 프로그램 폴더로 드래그**한 뒤, 응용 프로그램 폴더에서 실행합니다.
   DMG나 다운로드 폴더에서 바로 실행하면 statusLine 훅을 등록할 수 없어서, 응용 프로그램 폴더로 옮기겠냐고 묻습니다.
3. 위젯은 Dock 아이콘 없이 화면 하단에 뜹니다. 종료는 위젯의 ✕ 버튼이나 우클릭 메뉴에서 할 수 있습니다.
   statusLine 훅 자동 등록과 첫 수치 표시는 Windows와 같습니다.

### "Apple은 'ClauMeter'에 악성 코드가 없음을 확인할 수 없습니다" 경고가 뜬다면

클로미터는 Apple 개발자 인증서로 서명·공증되어 있지 않아서(연간 비용 문제로 Windows와 같은 이유) 처음 실행할 때
macOS가 막습니다. 한 번만 아래처럼 허용하면 이후로는 그냥 실행됩니다.

1. 경고창에서 **완료**를 누릅니다.
2. **시스템 설정 → 개인정보 보호 및 보안**으로 가서 아래쪽의 "ClauMeter이(가) 차단되었습니다" 옆 **그래도 열기**를 누르고
   암호(또는 Touch ID)로 확인합니다.
   (macOS 14 Sonoma 이하에서는 Finder에서 앱을 **Control+클릭 → 열기**로도 허용할 수 있습니다.)

그래도 "손상되었기 때문에 열 수 없습니다"라고 나오면 터미널에서 다운로드 격리 속성을 지운 뒤 다시 실행하세요:

```bash
xattr -dr com.apple.quarantine /Applications/ClauMeter.app
```

DMG의 해시는 릴리스에 함께 올라가는 `SHA256SUMS.txt`와 비교해서 확인할 수 있습니다:

```bash
shasum -a 256 ~/Downloads/ClauMeter-*-universal.dmg
```

## 업데이트

- **Windows**: 새 버전이 나오면 클로미터가 백그라운드에서 내려받은 뒤 알림을 띄웁니다. 알림이나 위젯 우클릭 메뉴의
  **재시작해서 업데이트**를 누르면 바로 적용되고, 누르지 않아도 클로미터를 종료할 때 설치됩니다.
- **macOS**: 새 버전이 나오면 알림이 뜨고, 누르면 다운로드 페이지가 열립니다. Apple 코드 서명이 없는 앱은 macOS가
  자동 설치를 허용하지 않아서, 새 DMG를 받아 응용 프로그램 폴더의 앱을 교체해 주세요.
- 앱을 켜고 조금 뒤, 그리고 6시간마다 자동으로 확인합니다. 위젯 우클릭 메뉴의 **업데이트 확인**으로 바로 확인할
  수도 있고, 자동 확인은 위젯 설정에서 끌 수 있습니다.
- 1.1.0 이하 버전에는 업데이트 기능이 없습니다. 이 경우 한 번만 새 설치 파일을 직접 받아 설치해 주세요.

## statusLine 훅 (자동 등록)

클로미터는 Claude Code 터미널이 상태줄을 그릴 때 남기는 실측값을 읽습니다. 이 훅은 앱을 실행할 때마다
자동으로 `~/.claude/settings.json`에 등록/최신화됩니다 - 사용자명이나 설치 위치(현재 사용자용/모든 사용자용/
커스텀 경로)가 달라도, 이름 변경이나 재설치로 경로가 바뀌어도 그때그때 다시 맞춰줍니다. 이미 `statusLine`을
다른 용도로 쓰고 있다면(클로미터가 등록한 값이 아니면) 덮어쓰지 않고 그대로 둡니다.

훅은 클로미터 실행 파일을 Node 모드(`ELECTRON_RUN_AS_NODE`)로 실행하므로 Node.js 설치가 필요 없습니다.
1.0.0에서 등록된 `node "...statuslineBridge.js"` 형태의 명령은 새 버전을 처음 실행할 때 자동으로 교체됩니다.

자동 등록이 실패했거나(권한 문제 등) 수동으로 확인하고 싶다면 `~/.claude/settings.json`에 아래처럼 직접
등록할 수 있습니다 (경로는 실제 설치 위치에 맞게 바꿔주세요).

**Windows** - Claude Code는 Git Bash가 있으면 Git Bash로, 없으면 PowerShell로 이 명령을 실행합니다. 두 셸에서
모두 동작하도록 **역슬래시 대신 슬래시**를 쓰고 **따옴표로 감싸지 마세요** (경로에 공백이 있으면 PowerShell에서 동작하지 않으니
`~/AppData/...`처럼 홈 폴더를 `~`로 줄여 쓰세요):

```json
{
  "statusLine": {
    "type": "command",
    "command": "C:/Users/<사용자명>/AppData/Local/Programs/ClauMeter/resources/app.asar.unpacked/claumeter-statusline.cmd"
  }
}
```

**macOS**:

```json
{
  "statusLine": {
    "type": "command",
    "command": "ELECTRON_RUN_AS_NODE=1 '/Applications/ClauMeter.app/Contents/MacOS/ClauMeter' '/Applications/ClauMeter.app/Contents/Resources/app.asar.unpacked/statuslineBridge.js'"
  }
}
```

## 개발자용

```bash
git clone https://github.com/dongho930/ClauMeter.git
cd ClauMeter
npm install
npm start           # 개발 모드 실행
npm run dist        # Windows: build/icon.ico를 사용해 Setup.exe 생성 (electron-builder)
npm run dist:mac    # macOS에서만: universal DMG 생성
```

Windows의 `npm run dist`는 `dist/`에 설치 파일 `ClauMeter.Setup.<버전>.exe`와, 자동 업데이트가 쓰는
`latest.yml`, `ClauMeter.Setup.<버전>.exe.blockmap`을 만듭니다.
로컬에서 `npm run dist`가 `Cannot create symbolic link` 오류로 실패하면, Windows 설정에서 개발자 모드를 켜거나
관리자 권한 터미널에서 다시 실행하세요 (electron-builder가 내려받는 도구 압축을 풀 때 심볼릭 링크 권한이 필요합니다).

### 릴리스 빌드 (GitHub Actions)

Windows 설치 파일과 macOS DMG는 GitHub Actions에서 각 OS 러너로 동시에 빌드합니다(`.github/workflows/build.yml`).
macOS용 DMG는 macOS에서만 만들 수 있어서, Mac이 없어도 되도록 이렇게 구성했습니다.

1. `package.json`의 `version`을 올리고 커밋합니다 (예: `1.1.0`).
2. 같은 버전의 태그를 푸시합니다: `git tag v1.1.0 && git push origin v1.1.0`
   (태그와 `version`이 다르면 빌드가 바로 실패합니다.)
3. 두 빌드가 모두 성공하면 `ClauMeter.Setup.<버전>.exe`, `latest.yml`, `.blockmap`, `ClauMeter-<버전>-universal.dmg`,
   `SHA256SUMS.txt`가 같은 이름의 GitHub 릴리스에 첨부됩니다. 릴리스가 없으면 초안(draft)으로 만들어지니, 내용을
   확인한 뒤 게시하세요.
4. **게시하는 순간 설치된 앱들이 업데이트를 받기 시작합니다** (초안 상태에서는 앱이 보지 않습니다). Windows 자동
   업데이트는 `latest.yml`에 적힌 파일 이름으로 설치 파일을 찾으므로, 첨부된 파일 이름을 바꾸거나 `latest.yml`을
   지우지 마세요.

태그 없이 **Actions → Build → Run workflow**로 수동 실행하면 릴리스에는 올리지 않고, 결과 파일을 그 실행 페이지의
Artifacts에서 받을 수 있습니다.

코드 서명 인증서는 쓰지 않습니다. Windows는 서명 없이, macOS는 ad-hoc 서명만 합니다(`build/adhoc-sign.js`).
정식 서명을 받는 방법은 [`docs/CODE_SIGNING.md`](docs/CODE_SIGNING.md)에 정리되어 있습니다.
macOS 아이콘은 `build/icon-mac.png`(1024×1024)를 사용합니다.

### AI 조언(Groq) 프록시

앱은 Groq API 키를 갖고 있지 않습니다. `proxy-server/`에 있는 작은 Vercel 서버리스 함수를 거쳐서만 Groq를
호출합니다 - 그래야 배포되는 앱 안에 키가 절대 포함되지 않습니다. 자세한 배포 방법은
[`proxy-server/README.md`](proxy-server/README.md)를 참고하세요. 직접 배포한 프록시 주소는
`main.js`의 `PROXY_URL` 상수에 넣으면 됩니다.

## 라이선스

[MIT](LICENSE)
