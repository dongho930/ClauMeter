# 클로미터 (ClauMeter)

Claude Code의 5시간/주간 사용량 한도를 실시간으로 보여주는 Windows 데스크톱 위젯입니다.

- Anthropic 서버가 직접 계산한 **실측 사용률**만 표시합니다 (비용 기반 추정 없음).
- 5시간·주간 게이지, 임계값(75%/90%) 색상 경고
- 과거 패턴을 학습해 "이 페이스면 구간 끝에 몇 %까지 갈지" 예측하는 AI 조언
- 한국어/영어/스페인어/프랑스어/독일어/포르투갈어/일본어/중국어/러시아어/이탈리아어/네덜란드어/폴란드어 12개 언어 지원

## 설치 (사용자용)

1. [Releases](../../releases)에서 최신 `클로미터-Setup.exe`를 내려받아 실행합니다.
2. 설치 후 처음 실행하면 위젯이 화면 하단에 뜹니다. Claude Code 터미널 세션을 사용하기 전까지는 "데이터 없음"으로 보이는 게 정상입니다.
3. 실측 사용률을 받아오려면 아래 **statusLine 훅 등록**을 한 번 해줘야 합니다.

### statusLine 훅 등록 (필수)

클로미터는 Claude Code 터미널이 상태줄을 그릴 때 남기는 실측값을 읽습니다. `~/.claude/settings.json`을 열어
`statusLine` 항목에 아래처럼 등록하세요 (설치 경로는 실제 설치 위치에 맞게 바꿔주세요 - 기본값은
`%LOCALAPPDATA%\Programs\클로미터\resources\app.asar.unpacked\statuslineBridge.js`입니다):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"C:\\Users\\<사용자명>\\AppData\\Local\\Programs\\클로미터\\resources\\app.asar.unpacked\\statuslineBridge.js\""
  }
}
```

등록 후 Claude Code 터미널을 한 번 열어서 아무 메시지나 보내면 위젯에 실제 수치가 뜨기 시작합니다.

## 개발자용

```bash
git clone <이 저장소>
cd claumeter
npm install
npm start          # 개발 모드 실행
npm run dist        # build/icon.ico를 사용해 Setup.exe 생성 (electron-builder)
```

### AI 조언(Groq) 프록시

앱은 Groq API 키를 갖고 있지 않습니다. `proxy-server/`에 있는 작은 Vercel 서버리스 함수를 거쳐서만 Groq를
호출합니다 - 그래야 배포되는 앱 안에 키가 절대 포함되지 않습니다. 자세한 배포 방법은
[`proxy-server/README.md`](proxy-server/README.md)를 참고하세요. 직접 배포한 프록시 주소는
`main.js`의 `PROXY_URL` 상수에 넣으면 됩니다.

## 라이선스

[MIT](LICENSE)
