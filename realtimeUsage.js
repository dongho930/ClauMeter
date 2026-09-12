// statuslineBridge.js가 남겨놓은 realtime_usage.json(Anthropic 서버가 계산한 실제 한도 %)을 읽는다.
// 이 파일은 사용자가 터미널에서 Claude Code 세션을 열어 상태줄이 그려질 때만 갱신된다. 마지막으로
// 캡처된 값이라도 그 구간(resetsAt)이 아직 끝나지 않았다면 여전히 유효한 실측값이므로 계속 보여준다 -
// 위젯을 껐다 켜거나 터미널을 한동안 안 열어도 다음 갱신이 있을 때까지 마지막 실측값을 유지한다.
// 구간이 실제로 끝난(resetsAt이 지난) 뒤에는 값이 의미가 없으므로 그때만 null로 돌려서
// main.js가 "데이터 없음"으로 표시하게 한다.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// __dirname은 설치된 앱에서는 읽기 전용 app.asar 내부를 가리키므로, statuslineBridge.js(asar 밖에서
// 독립 실행되는 Node 프로세스)가 실제로 쓰는 폴더(app.getPath('userData'))와 어긋난다. 반드시 같은
// 실제 폴더를 가리켜야 하며, 이 경로를 바꾸면 statuslineBridge.js도 같이 맞춰야 한다.
const REALTIME_PATH = path.join(app.getPath('userData'), 'realtime_usage.json');

function read() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(REALTIME_PATH, 'utf-8'));
  } catch {
    return { fiveHour: null, weekly: null, capturedAt: null };
  }

  const now = Date.now();

  const fiveHour =
    raw.fiveHour && typeof raw.fiveHour.resetsAt === 'number' && now < raw.fiveHour.resetsAt ? raw.fiveHour : null;
  const weekly =
    raw.weekly && typeof raw.weekly.resetsAt === 'number' && now < raw.weekly.resetsAt ? raw.weekly : null;

  // capturedAt은 상태줄이 이 값을 실제로 캡처한 시각이다. usageHistory가 같은 캡처를 중복
  // 기록하지 않는 판정 키로 쓴다.
  return { fiveHour, weekly, capturedAt: typeof raw.capturedAt === 'number' ? raw.capturedAt : null };
}

module.exports = { read };
