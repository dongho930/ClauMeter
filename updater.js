// 자동 업데이트.
// - Windows: electron-updater가 GitHub 릴리스의 latest.yml을 보고 새 버전을 백그라운드로 내려받는다.
//   다 받으면 알림과 우클릭 메뉴로 "재시작해서 업데이트"를 제안하고, 누르지 않아도 앱을 종료할 때 설치한다.
// - macOS: Apple Developer ID 서명이 없으면 macOS의 자동 업데이트(Squirrel.Mac)가 새 버전의 서명을 검증하지
//   못해서 설치할 수 없다. 그래서 GitHub 릴리스 API로 새 버전이 있는지만 확인하고, 알림을 누르면 다운로드
//   페이지를 연다.
// 앱은 "게시된" 릴리스만 본다 - GitHub Actions가 만든 초안(draft)은 게시하기 전까지 사용자에게 가지 않는다.
const { app, Notification, shell } = require('electron');

const REPO = 'dongho930/ClauMeter';
const RELEASES_PAGE_URL = `https://github.com/${REPO}/releases/latest`;
const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const FIRST_CHECK_DELAY_MS = 30 * 1000; // 앱을 켠 직후에는 위젯 표시가 먼저 - 조금 뒤에 확인한다
const CHECK_INTERVAL_MS = 6 * 3600 * 1000;

// status: 'idle' | 'checking' | 'downloading' | 'downloaded'(Windows) | 'available'(macOS)
let state = { status: 'idle', version: null, url: null };
let options = null; // { t, iconPath, isAutoCheckEnabled }
let autoUpdater = null;
let installStarted = false;
let notifiedVersion = null;
let lastNotification = null; // 참조를 잃으면 GC가 알림을 치워서 click 이벤트가 오지 않는다

function usesElectronUpdater() {
  return process.platform === 'win32';
}

function setState(status, version = null, url = null) {
  state = { status, version, url };
}

function notify(body, onClick) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: options.t('appTitle'), body, icon: options.iconPath });
  if (onClick) notification.on('click', onClick);
  notification.show();
  lastNotification = notification;
}

// 같은 버전으로 주기적인 확인마다 알림이 반복되지 않게, 버전당 한 번만 자동으로 알린다.
function notifyNewVersionOnce(force) {
  if (!force && notifiedVersion === state.version) return;
  notifiedVersion = state.version;
  if (state.status === 'downloaded') {
    notify(options.t('notifyUpdateReady', { version: state.version }), () => installNow());
  } else if (state.status === 'available') {
    notify(options.t('notifyUpdateAvailable', { version: state.version }), () => openDownloadPage());
  }
}

function setupElectronUpdater() {
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.disableWebInstaller = true; // NSIS 웹 설치 프로그램은 쓰지 않는다 (electron-updater 권장 설정)

  autoUpdater.on('update-available', (info) => setState('downloading', info.version));
  autoUpdater.on('update-not-available', () => setState('idle'));
  autoUpdater.on('update-downloaded', (info) => {
    setState('downloaded', info.version);
    notifyNewVersionOnce(false);
  });
  autoUpdater.on('error', () => {
    // 확인/다운로드 중 실패(오프라인 등) - 다음 주기에 다시 시도한다. 이미 받아둔 업데이트는 그대로 둔다.
    if (state.status !== 'downloaded') setState('idle');
  });
}

async function fetchLatestRelease() {
  const res = await fetch(LATEST_RELEASE_API_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ClauMeter' },
  });
  if (res.status === 404) return null; // 게시된 릴리스가 아직 없음
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  const data = await res.json();
  const version = String(data.tag_name || '').replace(/^v/, '');
  return version ? { version, url: data.html_url || RELEASES_PAGE_URL } : null;
}

// "1.10.0" > "1.9.3"처럼 숫자 단위로 비교한다. "-beta" 같은 꼬리표는 무시한다.
function isNewerVersion(candidate, current) {
  const parse = (v) => String(v).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

// manual=true면 사용자가 메뉴에서 직접 누른 것이므로, 결과(최신/실패/새 버전)를 항상 알림으로 알려준다.
async function check({ manual }) {
  if (!app.isPackaged) return;
  if (state.status === 'checking' || state.status === 'downloading') return;
  if (state.status === 'downloaded' || state.status === 'available') {
    if (manual) notifyNewVersionOnce(true);
    return;
  }

  setState('checking');
  try {
    if (usesElectronUpdater()) {
      await autoUpdater.checkForUpdates();
      // 결과는 위의 이벤트들이 state에 반영한다. 새 버전이 있으면 다운로드가 백그라운드로 이어진다.
      if (state.status === 'checking') setState('idle');
    } else {
      const latest = await fetchLatestRelease();
      if (latest && isNewerVersion(latest.version, app.getVersion())) {
        setState('available', latest.version, latest.url);
        notifyNewVersionOnce(manual);
      } else {
        setState('idle');
      }
    }
    if (manual && state.status === 'idle') notify(options.t('notifyUpToDate', { version: app.getVersion() }));
  } catch {
    if (state.status !== 'downloaded') setState('idle');
    if (manual) notify(options.t('notifyUpdateCheckFailed'));
  }
}

function installNow() {
  if (state.status !== 'downloaded' || installStarted) return;
  installStarted = true;
  // isSilent=true: 설치 화면 없이 설치, isForceRunAfter=true: 설치가 끝나면 앱을 다시 실행
  autoUpdater.quitAndInstall(true, true);
}

// main.js는 app.exit()으로 즉시 종료하는데, 그러면 electron-updater가 기다리는 정상 종료 과정을 거치지 않을
// 수 있다. 그래서 받아둔 업데이트가 있으면 종료할 때 여기서 직접 설치를 시작한다. 설치를 시작했으면 true를
// 돌려주며, 이때 앱 종료는 electron-updater가 이어서 처리한다.
function installOnQuitIfReady() {
  if (state.status !== 'downloaded' || installStarted) return false;
  installStarted = true;
  autoUpdater.quitAndInstall(true, false);
  return true;
}

function openDownloadPage() {
  shell.openExternal(state.url || RELEASES_PAGE_URL);
}

// 위젯 우클릭 메뉴에 넣을 항목. 개발 모드(npm start)에는 업데이트할 설치본이 없으므로 아무것도 넣지 않는다.
function buildMenuItems() {
  if (!options || !app.isPackaged) return [];
  const { t } = options;
  switch (state.status) {
    case 'downloaded':
      return [{ label: t('menuInstallUpdate', { version: state.version }), click: () => installNow() }];
    case 'available':
      return [{ label: t('menuDownloadUpdate', { version: state.version }), click: () => openDownloadPage() }];
    case 'checking':
      return [{ label: t('menuUpdateChecking'), enabled: false }];
    case 'downloading':
      return [{ label: t('menuUpdateDownloading'), enabled: false }];
    default:
      return [{ label: t('menuCheckUpdates'), click: () => check({ manual: true }) }];
  }
}

function init(opts) {
  options = opts;
  if (!app.isPackaged) return;
  if (usesElectronUpdater()) setupElectronUpdater();
  const autoCheck = () => {
    if (options.isAutoCheckEnabled()) check({ manual: false });
  };
  setTimeout(autoCheck, FIRST_CHECK_DELAY_MS);
  setInterval(autoCheck, CHECK_INTERVAL_MS);
}

module.exports = { init, buildMenuItems, installOnQuitIfReady, isNewerVersion, fetchLatestRelease };
