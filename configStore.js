const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// __dirname은 설치된 앱에서는 읽기 전용 app.asar 내부를 가리키므로 쓸 수 없다 -
// 반드시 Electron의 실제 쓰기 가능한 사용자 데이터 폴더를 써야 한다.
const DATA_DIR = app.getPath('userData');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const DEFAULT_CONFIG = {
  // 과거 기록으로 개인화 모델을 백필한 이력 - { version, fiveHourAt, weeklyAt, weeklyPhase }.
  // weeklyPhase는 백필에 사용한 주간 구간 격자의 위상 - 실측 초기화 시각이 들어와 격자가 달라지면
  // 학습을 버리고 다시 배워야 하므로 함께 기록한다.
  // 한도별로 따로 기록한다 (주간은 실제 초기화 시각을 알기 전까지 보류되므로 시점이 다르다).
  // version이 usageModel.MODEL_VERSION과 다르면 학습이 폐기된 것이므로 백필도 다시 수행한다.
  // (1.2.0까지 쓰던 usageModelBackfilledAt 키는 더 이상 읽지 않는다 - 남아있어도 무해.)
  usageModelBackfill: null,
  weekResetAt: null, // 다음 주간 초기화 시각 (ms epoch) - 이 시각을 지나면 자동으로 7일 뒤로 넘어감
  fiveHourResetAt: null, // 현재(또는 마지막) 5시간 구간의 초기화 시각 (ms epoch)
  fiveHourWindowPending: false, // true면 직전 구간이 끝났지만 아직 새 메시지가 없어 다음 구간이 시작 안 된 상태
  windowX: null,
  windowY: null,
  windowOpacity: null, // 사용자가 설정 화면에서 직접 조절한 위젯 투명도(0.2~0.8). null이면 기본값 사용
  autostart: false,
  language: null, // 'ko'/'en'/'es'/'fr'/'de'/'pt' 중 하나. null이면 OS 로케일로 자동 추정
  notificationsEnabled: true, // 5시간/주간 한도 50%/75%/90% 도달 시 토스트 알림
  // 구간별로 이미 알림을 울린 임계값 - { fiveHour: {resetAt, fired: [50,75]}, weekly: {...} }.
  // config.json에 저장해두므로 앱을 껐다 켜도 같은 구간 안에서는 중복 알림이 뜨지 않는다.
  notifiedThresholds: null,
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

module.exports = { loadConfig, saveConfig, DEFAULT_CONFIG };
