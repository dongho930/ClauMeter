let STR = null; // 현재 언어의 문자열 사전 (main 프로세스가 'locale-data'로 보내줌)

const languageLabelEl = document.getElementById('languageLabel');
const langSelect = document.getElementById('langSelect');
const langSelectBtn = document.getElementById('langSelectBtn');
const langSelectFlag = document.getElementById('langSelectFlag');
const langSelectName = document.getElementById('langSelectName');
const langMenu = document.getElementById('langMenu');
const opacityLabelEl = document.getElementById('opacityLabel');
const opacityInput = document.getElementById('opacity');
const opacityValueEl = document.getElementById('opacityValue');
const notificationsEnabledInput = document.getElementById('notificationsEnabled');
const notificationsLabelEl = document.getElementById('notificationsLabel');
const autoUpdateEnabledInput = document.getElementById('autoUpdateEnabled');
const autoUpdateLabelEl = document.getElementById('autoUpdateLabel');
const okBtn = document.getElementById('okBtn');
const cancelBtn = document.getElementById('cancelBtn');

let languagesPopulated = false;
let currentLangCode = null;
let minOpacity = 0.2;
let maxOpacity = 1.0;

// 슬라이더는 "투명도"(비쳐 보이는 정도)를 보여주지만, main.js가 다루는 값은 Electron의 실제
// opacity(불투명도 = 잘 보이는 정도)다. 그대로 연결하면 슬라이더를 올릴수록(투명도↑) 오히려
// 더 또렷하게 보이는 반대 현상이 생긴다. 자기 자신의 역함수라 양방향 변환에 그대로 재사용한다.
function flipOpacity(value) {
  return 1 - value;
}

// 네이티브 <select><option>은 이미지를 담을 수 없어서, 국기 SVG(flags.js)를 보여주려고
// 버튼 + 목록으로 된 커스텀 드롭다운을 직접 만든다.
function populateLanguages(languages, currentLang) {
  if (languagesPopulated) return;
  languagesPopulated = true;
  langMenu.innerHTML = '';
  for (const lang of languages) {
    const li = document.createElement('li');
    li.dataset.code = lang.code;
    const flag = document.createElement('span');
    flag.className = 'flag-icon';
    flag.innerHTML = (typeof FLAGS !== 'undefined' && FLAGS[lang.code]) || '';
    const name = document.createElement('span');
    name.textContent = lang.name;
    li.appendChild(flag);
    li.appendChild(name);
    li.addEventListener('click', () => selectLanguage(lang.code, lang.name));
    langMenu.appendChild(li);
  }
  const initialLang = languages.find((l) => l.code === currentLang) || languages[0];
  if (initialLang) selectLanguage(initialLang.code, initialLang.name, /* silent */ true);
}

function selectLanguage(code, name, silent) {
  currentLangCode = code;
  langSelectFlag.innerHTML = (typeof FLAGS !== 'undefined' && FLAGS[code]) || '';
  langSelectName.textContent = name;
  for (const li of langMenu.children) {
    li.classList.toggle('active', li.dataset.code === code);
  }
  closeLangMenu();
  // 언어는 확인/취소 흐름과 무관하게 고르는 즉시 적용된다 (투명도 미리보기와 달리 취소해도 되돌아가지 않음).
  if (!silent) window.api.setLanguage(code);
}

function openLangMenu() {
  langMenu.hidden = false;
}
function closeLangMenu() {
  langMenu.hidden = true;
}

langSelectBtn.addEventListener('click', () => {
  if (langMenu.hidden) openLangMenu();
  else closeLangMenu();
});

document.addEventListener('click', (e) => {
  if (!langSelect.contains(e.target)) closeLangMenu();
});

window.api.onLocaleData((data) => {
  STR = data.strings;
  document.documentElement.lang = data.lang;
  document.title = STR.settingsWindowTitle;
  languageLabelEl.textContent = STR.languageLabel;
  opacityLabelEl.textContent = STR.opacityLabel;
  notificationsLabelEl.textContent = STR.notificationsToggleLabel;
  autoUpdateLabelEl.textContent = STR.autoUpdateToggleLabel;
  okBtn.textContent = STR.ok;
  cancelBtn.textContent = STR.cancel;
  populateLanguages(data.languages, data.lang);
});

window.api.onCalibrateInit((data) => {
  populateLanguages(data.languages, data.lang);

  minOpacity = data.minOpacity != null ? data.minOpacity : 0.2;
  maxOpacity = data.maxOpacity != null ? data.maxOpacity : 1.0;
  // opacity가 클수록 투명도는 작아지므로, 슬라이더의 min/max는 opacity의 max/min에서 뒤집어 나온다.
  const minPercent = Math.round(flipOpacity(maxOpacity) * 100);
  const maxPercent = Math.round(flipOpacity(minOpacity) * 100);
  opacityInput.min = minPercent;
  opacityInput.max = maxPercent;
  opacityInput.value = Math.round(flipOpacity(data.opacity) * 100);
  opacityValueEl.textContent = `${opacityInput.value}%`;

  notificationsEnabledInput.checked = data.notificationsEnabled !== false;
  autoUpdateEnabledInput.checked = data.autoUpdateEnabled !== false;
});

opacityInput.addEventListener('input', () => {
  opacityValueEl.textContent = `${opacityInput.value}%`;
  const transparency = parseInt(opacityInput.value, 10) / 100;
  window.api.previewOpacity(flipOpacity(transparency));
});

function submit() {
  const transparency = parseInt(opacityInput.value, 10) / 100;
  window.api.submitCalibration({
    opacity: flipOpacity(transparency),
    notificationsEnabled: notificationsEnabledInput.checked,
    autoUpdateEnabled: autoUpdateEnabledInput.checked,
  });
}

okBtn.addEventListener('click', submit);
cancelBtn.addEventListener('click', () => window.api.cancelCalibration());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!langMenu.hidden) {
      closeLangMenu();
      return;
    }
    window.api.cancelCalibration();
  }
  if (e.key === 'Enter' && langMenu.hidden) submit();
});
