// Firebase設定
const firebaseConfig = {
  apiKey: "AIzaSyDk1M_1j8A-NdTk8qE5HCuhxcz4wBZ9PLE",
  authDomain: "tce4-98ab1.firebaseapp.com",
  projectId: "tce4-98ab1",
  storageBucket: "tce4-98ab1.firebasestorage.app",
  messagingSenderId: "213069443472",
  appId: "1:213069443472:web:9239d626fd91d662ca0315"
};

// Firebase初期化
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

// オフライン対応
db.enablePersistence().catch((err) => {
  console.log('Persistence error:', err);
});

// Firebase同期クラス
class TimecardFirebaseSync {
  constructor() {
    this.STORAGE_KEY = 'timeCards';
    this.isOnline = navigator.onLine;
    this.syncQueue = [];
    this.currentUser = null;
    
    this.initializeAuth();
    this.setupNetworkListeners();
  }

  // 認証初期化
  async initializeAuth() {
    auth.onAuthStateChanged(async (user) => {
      this.currentUser = user;
      if (user) {
        console.log('ユーザーログイン:', user.uid);
        await this.syncWithCloud();
        this.setupRealtimeListener();
      } else {
        console.log('匿名認証を開始...');
        await this.signInAnonymously();
      }
    });
  }

  // 匿名認証
  async signInAnonymously() {
    try {
      const result = await auth.signInAnonymously();
      console.log('匿名ユーザーとしてサインイン:', result.user.uid);
    } catch (error) {
      console.error('匿名認証エラー:', error);
    }
  }

  // ネットワーク状態監視
  setupNetworkListeners() {
    window.addEventListener('online', () => {
      this.isOnline = true;
      console.log('オンラインになりました');
      this.processSyncQueue();
    });
    
    window.addEventListener('offline', () => {
      this.isOnline = false;
      console.log('オフラインになりました');
    });
  }

  // リアルタイムリスナー設定
  setupRealtimeListener() {
    if (!this.currentUser) return;
    
    const userDoc = db.collection('timecards').doc(this.currentUser.uid);
    
    userDoc.onSnapshot((doc) => {
      if (doc.exists && !doc.metadata.hasPendingWrites) {
        const cloudData = doc.data().records || {};
        this.mergeCloudData(cloudData);
      }
    }, (error) => {
      console.error('リアルタイム同期エラー:', error);
    });
  }

  // クラウドデータとローカルデータのマージ
  mergeCloudData(cloudData) {
    const localData = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '{}');
    const mergedData = this.deepMergeTimeCards(localData, cloudData);
    
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(mergedData));
    
    // UIの更新
    if (typeof displayEmpRecords === 'function') {
      displayEmpRecords();
    }
    
    console.log('データマージ完了');
  }

  // タイムカードデータの深いマージ
  deepMergeTimeCards(local, cloud) {
    const merged = { ...local };
    
    Object.keys(cloud).forEach(employeeName => {
      if (!merged[employeeName]) {
        merged[employeeName] = cloud[employeeName];
      } else {
        Object.keys(cloud[employeeName]).forEach(date => {
          if (!merged[employeeName][date]) {
            merged[employeeName][date] = cloud[employeeName][date];
          } else {
            const localRecords = merged[employeeName][date];
            const cloudRecords = cloud[employeeName][date];
            const mergedRecords = [...localRecords];
            
            cloudRecords.forEach(cloudRecord => {
              const exists = localRecords.some(localRecord => 
                localRecord.checkIn === cloudRecord.checkIn &&
                localRecord.checkOut === cloudRecord.checkOut
              );
              
              if (!exists) {
                mergedRecords.push(cloudRecord);
              }
            });
            
            merged[employeeName][date] = mergedRecords;
          }
        });
      }
    });
    
    return merged;
  }

  // クラウドとの同期
  async syncWithCloud() {
    if (!this.currentUser || !this.isOnline) return;
    
    try {
      const localData = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '{}');
      const userDoc = db.collection('timecards').doc(this.currentUser.uid);
      
      await userDoc.set({
        records: localData,
        lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      
      console.log('クラウド同期完了');
    } catch (error) {
      console.error('同期エラー:', error);
      const localData = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '{}');
      this.syncQueue.push({ action: 'sync', data: localData });
    }
  }

  // データ保存（ローカル + クラウド）
  async saveTimeCard(employeeName, type) {
    const now = this.getJstDate();
    const today = this.getLocalDateString(now);
    const data = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '{}');
    
    if (!data[employeeName]) data[employeeName] = {};
    if (!data[employeeName][today]) data[employeeName][today] = [];
    
    const records = data[employeeName][today];
    const lastRecord = records.length ? records[records.length - 1] : null;
    
    if (type === 'in') {
      if (lastRecord && lastRecord.checkOut === null) {
        throw new Error('連続した出勤はできません');
      }
      records.push({ 
        checkIn: now.toTimeString().slice(0, 5), 
        checkOut: null,
        id: this.generateId()
      });
    } else {
      if (!lastRecord || lastRecord.checkOut !== null) {
        throw new Error('先に出勤してください');
      }
      lastRecord.checkOut = now.toTimeString().slice(0, 5);
    }
    
    // ローカル保存
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
    
    // クラウド同期
    if (this.isOnline && this.currentUser) {
      try {
        await this.syncWithCloud();
      } catch (error) {
        console.error('クラウド同期失敗:', error);
        this.syncQueue.push({ action: 'save', employeeName, type, data });
      }
    } else {
      this.syncQueue.push({ action: 'save', employeeName, type, data });
    }
    
    return data;
  }

  // 同期キューの処理
  async processSyncQueue() {
    if (!this.isOnline || !this.currentUser || this.syncQueue.length === 0) return;
    
    console.log(`${this.syncQueue.length}件の未同期データを処理中...`);
    
    while (this.syncQueue.length > 0) {
      const item = this.syncQueue.shift();
      try {
        await this.syncWithCloud();
        console.log('キューアイテム同期完了');
      } catch (error) {
        console.error('キュー処理エラー:', error);
        this.syncQueue.unshift(item);
        break;
      }
    }
  }

  // 日本時間取得
  getJstDate() {
    return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  }

  // 日付文字列生成
  getLocalDateString(date) {
    const jstDate = date || this.getJstDate();
    const y = jstDate.getFullYear();
    const m = String(jstDate.getMonth() + 1).padStart(2, '0');
    const d = String(jstDate.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // ユニークID生成
  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
}

// Firebase同期インスタンス
const firebaseSync = new TimecardFirebaseSync();

// 定数とグローバル変数
const STORAGE_KEY = 'timeCards';
let deferredPrompt;

// Service Worker登録
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((registration) => {
        console.log('SW registered: ', registration);
      })
      .catch((registrationError) => {
        console.log('SW registration failed: ', registrationError);
      });
  });
}

// PWAインストールプロンプト
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const installButton = document.getElementById('installPrompt');
  installButton.style.display = 'block';
  installButton.classList.add('show');
});

// インストールボタンのクリックイベント
document.getElementById('installPrompt').addEventListener('click', () => {
  const installButton = document.getElementById('installPrompt');
  installButton.style.display = 'none';
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then((choiceResult) => {
    if (choiceResult.outcome === 'accepted') {
      console.log('User accepted the A2HS prompt');
    } else {
      console.log('User dismissed the A2HS prompt');
    }
    deferredPrompt = null;
  });
});

// オンライン/オフライン状態の監視
function updateOnlineStatus() {
  const offlineIndicator = document.getElementById('offlineIndicator');
  if (navigator.onLine) {
    offlineIndicator.classList.remove('show');
  } else {
    offlineIndicator.classList.add('show');
  }
}

window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

// 効果音再生関数
function playSuccessSound(type = 'in') {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    if (type === 'in') {
      playChord(audioContext, [523.25, 659.25, 783.99], 0.3, 0.1);
      setTimeout(() => playChord(audioContext, [783.99, 987.77, 1174.66], 0.3, 0.1), 150);
    } else {
      playChord(audioContext, [783.99, 659.25, 523.25], 0.3, 0.1);
      setTimeout(() => playChord(audioContext, [523.25, 415.30, 329.63], 0.3, 0.1), 150);
    }
  } catch (error) {
    console.log('音声再生に対応していません:', error);
  }
}

function playChord(audioContext, frequencies, volume = 0.3, duration = 0.2) {
  frequencies.forEach(freq => {
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    oscillator.frequency.setValueAtTime(freq, audioContext.currentTime);
    oscillator.type = 'sine';
    
    gainNode.gain.setValueAtTime(0, audioContext.currentTime);
    gainNode.gain.linearRampToValueAtTime(volume, audioContext.currentTime + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration);
    
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + duration);
  });
}

// クリップボードにコピー
function copyToClipboard(code, message) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(code).then(() => {
      showAlert(`共有コードをコピー: ${code}`, 'success');
    }).catch(() => {
      fallbackCopy(message);
    });
  } else {
    fallbackCopy(message);
  }
}

function fallbackCopy(text) {
  const textArea = document.createElement('textarea');
  textArea.value = text;
  document.body.appendChild(textArea);
  textArea.select();
  try {
    document.execCommand('copy');
    showAlert('共有コードをコピーしました', 'success');
  } catch (err) {
    showAlert(`共有コード: ${text}`, 'info');
  }
  document.body.removeChild(textArea);
}

// 共有アカウントに接続
async function connectToSharedAccount(code) {
  try {
    // コードからフルユーザーIDを検索
    const snapshot = await db.collection('timecards').get();
    let targetUserId = null;
    
    snapshot.forEach(doc => {
      const userId = doc.id;
      if (userId.substring(0, 8).toUpperCase() === code) {
        targetUserId = userId;
      }
    });
    
    if (!targetUserId) {
      showAlert('共有コードが見つかりません', 'error');
      return;
    }
    
    // 共有アカウントのデータを取得
    const targetDoc = await db.collection('timecards').doc(targetUserId).get();
    if (!targetDoc.exists) {
      showAlert('データが存在しません', 'error');
      return;
    }
    
    // ローカルデータと統合
    const targetData = targetDoc.data().records || {};
    const localData = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const mergedData = firebaseSync.deepMergeTimeCards(localData, targetData);
    
    // ローカルに保存
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mergedData));
    
    // 共有アカウント設定を保存
    localStorage.setItem('sharedAccountId', targetUserId);
    
    // UI更新
    displayEmpRecords();
    showAlert(`データを統合しました (${Object.keys(mergedData).length}名)`, 'success');
    
  } catch (error) {
    console.error('共有アカウント接続エラー:', error);
    showAlert('接続に失敗しました', 'error');
  }
}

// Firebase同期クラスに共有アカウント同期を追加
firebaseSync.syncWithSharedAccount = async function() {
  const sharedAccountId = localStorage.getItem('sharedAccountId');
  if (!sharedAccountId || !this.currentUser || !this.isOnline) return;
  
  try {
    const localData = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '{}');
    
    // 自分のアカウントに保存
    await db.collection('timecards').doc(this.currentUser.uid).set({
      records: localData,
      lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    
    // 共有アカウントにも保存
    await db.collection('timecards').doc(sharedAccountId).set({
      records: localData,
      lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    
    console.log('共有アカウント同期完了');
  } catch (error) {
    console.error('共有アカウント同期エラー:', error);
  }
};

// 元のsyncWithCloud関数を拡張
const originalSyncWithCloud = firebaseSync.syncWithCloud.bind(firebaseSync);
firebaseSync.syncWithCloud = async function() {
  await originalSyncWithCloud();
  await this.syncWithSharedAccount();
};

// 日本時間取得
function getJstDate() {
  return new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Tokyo"}));
}

// 時計更新
function updateClock() {
  const now = getJstDate();
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const date = now.getDate();
  const weekday = weekdays[now.getDay()];
  
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  
  const dateStr = `${year}年${month}月${date}日（${weekday}）`;
  const timeStr = `${hours}:${minutes}:${seconds}`;
  
  document.getElementById('clockDate').textContent = dateStr;
  document.getElementById('clockTime').textContent = timeStr;
}

// YYYY-MM-DD形式の日付文字列
function getLocalDateString(date) {
  const jstDate = date || getJstDate();
  const y = jstDate.getFullYear();
  const m = String(jstDate.getMonth()+1).padStart(2,'0');
  const d = String(jstDate.getDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}

// 11日区切りの期間取得
function getCurrentPeriod() {
  const today = getJstDate();
  const day = today.getDate();
  const month = today.getMonth();
  const year = today.getFullYear();
  
  let periodStart, periodEnd;
  
  if (day >= 11) {
    periodStart = new Date(year, month, 11);
    periodEnd = new Date(year, month + 1, 10);
  } else {
    periodStart = new Date(year, month - 1, 11);
    periodEnd = new Date(year, month, 10);
  }
  
  return { start: periodStart, end: periodEnd };
}

// 勤務時間計算
function calculateWorkingHours(checkIn, checkOut) {
  const start = new Date(`1970-01-01T${checkIn}`);
  const end = new Date(`1970-01-01T${checkOut}`);
  return (end - start) / (1000 * 60 * 60);
}

// 早朝勤務時間計算
function calculateEarlyMorningHours(checkIn, checkOut) {
  const start = new Date(`1970-01-01T${checkIn}`);
  const end = new Date(`1970-01-01T${checkOut}`);
  const limit = new Date('1970-01-01T08:30');
  
  if (end <= limit) {
    return (end - start) / (1000 * 60 * 60);
  } else if (start < limit) {
    return (limit - start) / (1000 * 60 * 60);
  }
  return 0;
}

// 夕方勤務時間計算
function calculateEveningHours(checkIn, checkOut) {
  const start = new Date(`1970-01-01T${checkIn}`);
  const end = new Date(`1970-01-01T${checkOut}`);
  const limit = new Date('1970-01-01T16:00');
  
  if (start >= limit) {
    return (end - start) / (1000 * 60 * 60);
  } else if (end > limit) {
    return (end - limit) / (1000 * 60 * 60);
  }
  return 0;
}

// 名前の使用順序を更新
function updateNameUsageOrder(name) {
  let nameUsage = JSON.parse(localStorage.getItem('nameUsageOrder') || '{}');
  nameUsage[name] = Date.now();
  localStorage.setItem('nameUsageOrder', JSON.stringify(nameUsage));
}

// 既存の名前リストを取得
function getExistingNames() {
  const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  const nameUsage = JSON.parse(localStorage.getItem('nameUsageOrder') || '{}');
  const names = Object.keys(data);
  
  const namesWithUsage = names.map(name => {
    const lastUsed = nameUsage[name] || 0;
    return { name, lastUsed };
  });
  
  namesWithUsage.sort((a, b) => {
    return b.lastUsed - a.lastUsed;
  });
  
  return namesWithUsage.map(item => item.name);
}

// クリアボタンの表示制御
function updateClearButton(inputId, clearBtnId) {
  const input = document.getElementById(inputId);
  const clearBtn = document.getElementById(clearBtnId);
  
  if (input && clearBtn) {
    if (input.value.trim()) {
      clearBtn.classList.add('show');
    } else {
      clearBtn.classList.remove('show');
    }
  }
}

// ドロップダウン制御用のフラグ
let isDropdownActionInProgress = false;

// ドロップダウンメニューを表示
function showDropdown(inputId, dropdownId) {
  if (isDropdownActionInProgress) return;
  
  if (dropdownId === 'empNameDropdown') {
    hideDropdown('searchEmpNameDropdown');
  } else if (dropdownId === 'searchEmpNameDropdown') {
    hideDropdown('empNameDropdown');
  }
  
  const input = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  const names = getExistingNames();
  const inputValue = input.value.toLowerCase().trim();
  
  const filteredNames = names.filter(name => 
    name.toLowerCase().includes(inputValue)
  );
  
  dropdown.innerHTML = '';
  
  if (filteredNames.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'dropdown-empty';
    emptyDiv.textContent = inputValue ? '該当する名前が見つかりません' : '記録された名前はありません';
    dropdown.appendChild(emptyDiv);
  } else {
    filteredNames.forEach(name => {
      const item = document.createElement('div');
      item.className = 'dropdown-item';
      
      const nameSpan = document.createElement('span');
      nameSpan.textContent = name;
      
      const nameUsage = JSON.parse(localStorage.getItem('nameUsageOrder') || '{}');
      const lastUsed = nameUsage[name];
      const infoSpan = document.createElement('span');
      infoSpan.className = 'dropdown-item-info';
      if (lastUsed) {
        const lastUsedDate = new Date(lastUsed);
        const today = new Date();
        const diffDays = Math.floor((today - lastUsedDate) / (1000 * 60 * 60 * 24));
        
        if (diffDays === 0) {
          infoSpan.textContent = '今日';
        } else if (diffDays === 1) {
          infoSpan.textContent = '昨日';
        } else if (diffDays < 7) {
          infoSpan.textContent = `${diffDays}日前`;
        } else {
          infoSpan.textContent = `${Math.floor(diffDays / 7)}週間前`;
        }
      } else {
        infoSpan.textContent = '';
      }
      
      item.appendChild(nameSpan);
      item.appendChild(infoSpan);
      
      const handleItemClick = () => {
        isDropdownActionInProgress = true;
        input.value = name;
        hideDropdown(dropdownId);
        
        if (inputId === 'empName') {
          updateNameUsageOrder(name);
          updateButtons(name);
          updateClearButton('empName', 'clearEmpNameBtn');
        } else if (inputId === 'searchEmpName') {
          displayEmpRecords();
          updateClearButton('searchEmpName', 'clearSearchBtn');
        }
        
        setTimeout(() => {
          isDropdownActionInProgress = false;
        }, 300);
      };

      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleItemClick();
      });
      
      dropdown.appendChild(item);
    });
  }
  
  dropdown.classList.add('show');
  
  setTimeout(() => {
    dropdown.scrollTop = 0;
  }, 0);
}

// ドロップダウンメニューを非表示
function hideDropdown(dropdownId) {
  const dropdown = document.getElementById(dropdownId);
  dropdown.classList.remove('show');
}

// 全てのドロップダウンを非表示
function hideAllDropdowns() {
  hideDropdown('empNameDropdown');
  hideDropdown('searchEmpNameDropdown');
}

// 確認ダイアログを表示
function showConfirmDialog(message, onConfirm) {
  const dialog = document.createElement('div');
  dialog.className = 'confirm-dialog';
  
  dialog.innerHTML = `
    <div class="confirm-dialog-content">
      <h3>確認</h3>
      <p>${message}</p>
      <div class="confirm-buttons">
        <button class="confirm-btn cancel">キャンセル</button>
        <button class="confirm-btn delete">削除</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(dialog);
  
  const cancelBtn = dialog.querySelector('.cancel');
  const deleteBtn = dialog.querySelector('.delete');
  
  const closeDialog = () => {
    dialog.style.opacity = '0';
    setTimeout(() => {
      if (document.body.contains(dialog)) {
        document.body.removeChild(dialog);
      }
    }, 300);
  };
  
  cancelBtn.addEventListener('click', closeDialog);
  deleteBtn.addEventListener('click', () => {
    onConfirm();
    closeDialog();
  });
  
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      closeDialog();
    }
  });
}

// 個別データ削除
function deleteRecord(name, date, recordIndex) {
  const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  
  if (data[name] && data[name][date] && data[name][date][recordIndex]) {
    data[name][date].splice(recordIndex, 1);
    
    if (data[name][date].length === 0) {
      delete data[name][date];
    }
    
    if (Object.keys(data[name]).length === 0) {
      delete data[name];
    }
    
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    displayEmpRecords();
    updateButtons(document.getElementById('empName').value.trim());
    showAlert('記録を削除しました', 'success');
  }
}

// 長押し機能を追加
function addLongPressToRecord(element, name, date, recordIndex) {
  let pressTimer = null;
  let isLongPress = false;
  let startCoords = { x: 0, y: 0 };
  
  const startPress = (e) => {
    if (e.target.classList.contains('delete-btn')) {
      return;
    }
    
    e.preventDefault();
    
    isLongPress = false;
    element.classList.add('long-pressing');
    
    if (e.touches) {
      startCoords.x = e.touches[0].clientX;
      startCoords.y = e.touches[0].clientY;
    } else {
      startCoords.x = e.clientX;
      startCoords.y = e.clientY;
    }
    
    pressTimer = setTimeout(() => {
      isLongPress = true;
      element.classList.remove('long-pressing');
      showDeleteButton(element, name, date, recordIndex);
      
      if (navigator.vibrate) {
        navigator.vibrate(50);
      }
    }, 3000);
  };
  
  const endPress = (e) => {
    if (e && e.target && e.target.classList.contains('delete-btn')) {
      return;
    }
    
    clearTimeout(pressTimer);
    element.classList.remove('long-pressing');
  };
  
  const moveHandler = (e) => {
    if (element.querySelector('.delete-btn')) {
      return;
    }
    
    let currentX, currentY;
    if (e.touches) {
      currentX = e.touches[0].clientX;
      currentY = e.touches[0].clientY;
    } else {
      currentX = e.clientX;
      currentY = e.clientY;
    }
    
    const distance = Math.sqrt(
      Math.pow(currentX - startCoords.x, 2) + 
      Math.pow(currentY - startCoords.y, 2)
    );
    
    if (distance > 20) {
      endPress();
    }
  };
  
  element.addEventListener('touchstart', startPress, { passive: false });
  element.addEventListener('touchend', endPress, { passive: true });
  element.addEventListener('touchmove', moveHandler, { passive: true });
  element.addEventListener('touchcancel', endPress, { passive: true });
  
  element.addEventListener('mousedown', startPress);
  element.addEventListener('mouseup', endPress);
  element.addEventListener('mouseleave', endPress);
  element.addEventListener('mousemove', moveHandler);
  
  element.addEventListener('click', (e) => {
    if (isLongPress && !e.target.classList.contains('delete-btn')) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  
  element.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });
}

// 削除ボタンを表示
function showDeleteButton(recordElement, name, date, recordIndex) {
  const existingBtn = recordElement.querySelector('.delete-btn');
  if (existingBtn) {
    existingBtn.remove();
  }
  
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'delete-btn';
  deleteBtn.textContent = '削除';
  
  const handleDeleteClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    
    showConfirmDialog(
      'この勤怠記録を削除しますか？<br>この操作は取り消せません。',
      () => deleteRecord(name, date, recordIndex)
    );
  };
  
  deleteBtn.addEventListener('click', handleDeleteClick, true);
  deleteBtn.addEventListener('touchend', handleDeleteClick, true);
  
  deleteBtn.addEventListener('touchstart', (e) => {
    e.stopPropagation();
  }, true);
  
  deleteBtn.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  }, true);
  
  recordElement.appendChild(deleteBtn);
  
  setTimeout(() => {
    if (deleteBtn.parentNode) {
      deleteBtn.remove();
    }
  }, 5000);
}

// 月次サマリー表示
function showMonthlySummary(name) {
  const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  const userData = data[name];
  if (!userData) return;

  const period = getCurrentPeriod();
  
  let totalDays = 0;
  let totalHours = 0;
  let totalEarlyMorning = 0;
  let totalEvening = 0;
  let incompleteCount = 0;

  const today = getLocalDateString(getJstDate());

  Object.keys(userData).forEach(date => {
    const recordDate = new Date(date);
    if (recordDate >= period.start && recordDate <= period.end) {
      userData[date].forEach(rec => {
        if (rec.checkIn) {
          totalDays++;
          if (rec.checkOut) {
            const hours = calculateWorkingHours(rec.checkIn, rec.checkOut);
            const earlyMorning = calculateEarlyMorningHours(rec.checkIn, rec.checkOut);
            const evening = calculateEveningHours(rec.checkIn, rec.checkOut);
            
            totalHours += hours;
            totalEarlyMorning += earlyMorning;
            totalEvening += evening;
          } else {
            const isToday = date === today;
            if (!isToday) {
              incompleteCount++;
            }
          }
        }
      });
    }
  });

  const totalNormal = totalHours - totalEarlyMorning - totalEvening;
  const totalOvertime = Math.max(0, totalHours - totalDays * 8);
  
  const monthNames = ["1月", "2月", "3月", "4月", "5月", "6月", 
                     "7月", "8月", "9月", "10月", "11月", "12月"];
  
  const startMonth = period.start.getMonth();
  const endMonth = period.end.getMonth();
  let periodLabel;
  
  if (startMonth === endMonth) {
    periodLabel = period.start.getFullYear() + "年 " + monthNames[startMonth];
  } else {
    const startYear = period.start.getFullYear();
    const endYear = period.end.getFullYear();
    if (startYear === endYear) {
      periodLabel = startYear + "年 " + monthNames[startMonth] + "11日～" + monthNames[endMonth] + "10日";
    } else {
      periodLabel = startYear + "年" + monthNames[startMonth] + "11日～" + endYear + "年" + monthNames[endMonth] + "10日";
    }
  }

  const averageHours = totalDays > 0 ? (totalHours / totalDays).toFixed(1) : '0.0';

  const summaryContainer = document.getElementById('summaryContainer');
  
  const existingPanel = document.getElementById('summaryPanel');
  if (existingPanel) {
    existingPanel.remove();
  }
  
  const summaryPanel = document.createElement('div');
  summaryPanel.className = 'summary-panel';
  summaryPanel.id = 'summaryPanel';
  summaryPanel.style.display = 'block';
  
  summaryPanel.innerHTML = 
    '<div class="summary-header">' +
      '<div class="summary-title">' + name + 'さんの月次サマリー</div>' +
      '<div class="summary-period">' + periodLabel + '</div>' +
    '</div>' +
    
    '<div class="summary-stats">' +
      '<div class="stat-card">' +
        '<div class="stat-value">' + totalDays + '</div>' +
        '<div class="stat-label">出勤日数</div>' +
      '</div>' +
      '<div class="stat-card">' +
        '<div class="stat-value">' + totalHours.toFixed(1) + '</div>' +
        '<div class="stat-label">総勤務時間</div>' +
      '</div>' +
      '<div class="stat-card">' +
        '<div class="stat-value">' + totalOvertime.toFixed(1) + '</div>' +
        '<div class="stat-label">残業時間</div>' +
      '</div>' +
      '<div class="stat-card">' +
        '<div class="stat-value">' + incompleteCount + '</div>' +
        '<div class="stat-label">要確認</div>' +
      '</div>' +
    '</div>' +

    '<div class="summary-details">' +
      '<div style="font-weight: 600; margin-bottom: 12px; color: #424245;">詳細</div>' +
      '<div class="summary-row">' +
        '<span>平均勤務時間/日</span>' +
        '<span>' + averageHours + '時間</span>' +
      '</div>' +
      '<div class="summary-row">' +
        '<span>通常勤務時間</span>' +
        '<span>' + totalNormal.toFixed(1) + '時間</span>' +
      '</div>' +
      '<div class="summary-row">' +
        '<span>早朝勤務時間</span>' +
        '<span>' + totalEarlyMorning.toFixed(1) + '時間</span>' +
      '</div>' +
      '<div class="summary-row">' +
        '<span>夕方勤務時間</span>' +
        '<span>' + totalEvening.toFixed(1) + '時間</span>' +
      '</div>' +
    '</div>';
    
  summaryContainer.appendChild(summaryPanel);
  
  const summaryButton = document.querySelector('.summary-button');
  if (summaryButton) {
    summaryButton.textContent = 'サマリーを閉じる';
    summaryButton.classList.add('close-mode');
    summaryButton.onclick = () => toggleSummary();
  }
}

// サマリーのトグル機能
function toggleSummary() {
  const panel = document.getElementById('summaryPanel');
  const button = document.querySelector('.summary-button');
  
  if (panel && button) {
    if (panel.style.display === 'block') {
      panel.style.display = 'none';
      const name = button.getAttribute('data-name');
      if (name) {
        button.textContent = `${name}さんの月次サマリーを表示`;
        button.classList.remove('close-mode');
        button.onclick = () => showMonthlySummary(name);
      }
    }
  }
}

// サマリーを閉じる
function closeSummary() {
  const panel = document.getElementById('summaryPanel');
  const button = document.querySelector('.summary-button');
  
  if (panel) {
    panel.style.display = 'none';
  }
  
  if (button) {
    const name = button.getAttribute('data-name');
    if (name) {
      button.textContent = `${name}さんの月次サマリーを表示`;
      button.classList.remove('close-mode');
      button.onclick = () => showMonthlySummary(name);
    }
  }
}

// 出勤／退勤（Firebase対応版）
async function saveEmpPair(name, type) {
  try {
    await firebaseSync.saveTimeCard(name, type);
    
    playSuccessSound(type);
    showAlert('記録しました', 'success');
    
    updateNameUsageOrder(name);
    
    document.getElementById('empName').value = '';
    updateButtons('');
    updateClearButton('empName', 'clearEmpNameBtn');
    displayEmpRecords();
  } catch (error) {
    showAlert(error.message, 'error');
  }
}

// アラート表示
function showAlert(message, type = 'info') {
  const alertDiv = document.createElement('div');
  alertDiv.className = `alert ${type}`;
  alertDiv.textContent = message;
  
  document.body.appendChild(alertDiv);
  
  setTimeout(() => {
    alertDiv.style.animation = 'slideOutAlertTop 0.3s ease-in forwards';
    setTimeout(() => {
      if (document.body.contains(alertDiv)) {
        document.body.removeChild(alertDiv);
      }
    }, 300);
  }, 3000);
}

// ボタン制御
function updateButtons(name) {
  const btnIn = document.getElementById('btnClockIn');
  const btnOut = document.getElementById('btnClockOut');
  if (!name) {
    btnIn.disabled = true;
    btnOut.disabled = true;
    return;
  }
  const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')[name] || {};
  const dates = Object.keys(data).sort().reverse();
  const lastDate = dates[0];
  const lastRec = lastDate ? data[lastDate][data[lastDate].length-1] : null;
  const today = getLocalDateString(getJstDate());
  
  if (!lastRec || lastRec.checkOut !== null || lastDate !== today) {
    btnIn.disabled = false;
    btnOut.disabled = true;
  } else {
    btnIn.disabled = true;
    btnOut.disabled = false;
  }
}

// 一覧表示＋検索
function displayEmpRecords() {
  const filter = document.getElementById('searchEmpName').value.trim().toLowerCase();
  const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  const container = document.getElementById('empResult');
  container.innerHTML = '';
  
  const today = getLocalDateString(getJstDate());
  
  let hasRecords = false;
  let searchedNames = [];
  
  Object.keys(data)
    .filter(name => name.toLowerCase().includes(filter))
    .forEach(name => {
      if (!searchedNames.includes(name)) {
        searchedNames.push(name);
      }
      
      Object.keys(data[name]).sort().reverse().forEach(date => {
        const records = data[name][date];
        records.slice().reverse().forEach((rec, reverseIndex) => {
          if (rec.checkIn) {
            const recordIndex = records.length - 1 - reverseIndex;
            
            hasRecords = true;
            const div = document.createElement('div');
            div.className = 'record';
            
            const info = document.createElement('div');
            info.className = 'record-info';
            
            const nameDiv = document.createElement('div');
            nameDiv.className = 'record-name';
            nameDiv.textContent = name;
            
            const timeDiv = document.createElement('div');
            timeDiv.className = 'record-time';
            timeDiv.textContent = `${date} ${rec.checkIn}${rec.checkOut ? ` - ${rec.checkOut}` : ''}`;
            
            info.appendChild(nameDiv);
            info.appendChild(timeDiv);
            
            const badge = document.createElement('div');
            
            const isToday = date === today;
            let statusClass, statusText;
            
            if (rec.checkOut) {
              statusClass = 'status-completed';
              statusText = '完了';
            } else if (isToday) {
              statusClass = 'status-working';
              statusText = '勤務中';
            } else {
              statusClass = 'status-overtime';
              statusText = '要確認';
            }
            
            badge.className = `status-badge ${statusClass}`;
            badge.textContent = statusText;
            
            div.appendChild(info);
            div.appendChild(badge);
            
            addLongPressToRecord(div, name, date, recordIndex);
            
            container.appendChild(div);
          }
        });
      });
    });
  
  const existingButton = document.querySelector('.summary-button');
  const existingPanel = document.getElementById('summaryPanel');
  
  let currentSummaryName = null;
  if (existingPanel && existingPanel.style.display === 'block') {
    const titleElement = existingPanel.querySelector('.summary-title');
    if (titleElement) {
      const titleText = titleElement.textContent;
      const match = titleText.match(/^(.+)さんの月次サマリー$/);
      if (match) {
        currentSummaryName = match[1];
      }
    }
  }
  
  if (currentSummaryName && 
      (searchedNames.length !== 1 || !searchedNames.includes(currentSummaryName))) {
    closeSummary();
  }
  
  if (searchedNames.length === 1 && hasRecords) {
    if (!existingButton) {
      const summaryButton = document.createElement('button');
      summaryButton.className = 'summary-button';
      summaryButton.textContent = `${searchedNames[0]}さんの月次サマリーを表示`;
      summaryButton.onclick = () => showMonthlySummary(searchedNames[0]);
      summaryButton.setAttribute('data-name', searchedNames[0]);
      document.getElementById('summaryContainer').appendChild(summaryButton);
    } else {
      existingButton.textContent = `${searchedNames[0]}さんの月次サマリーを表示`;
      existingButton.onclick = () => showMonthlySummary(searchedNames[0]);
      existingButton.setAttribute('data-name', searchedNames[0]);
    }
  } else {
    if (existingButton) {
      existingButton.remove();
    }
  }
  
  if (!hasRecords) {
    const noData = document.createElement('div');
    noData.className = 'no-data';
    noData.textContent = 'まだ記録がありません';
    container.appendChild(noData);
  }
}

// DOMContentLoaded イベント
document.addEventListener('DOMContentLoaded', () => {
  updateOnlineStatus();
  
  const nameInput = document.getElementById('empName');
  const searchInput = document.getElementById('searchEmpName');
  const btnClockIn = document.getElementById('btnClockIn');
  const btnClockOut = document.getElementById('btnClockOut');
  const clearSearchBtn = document.getElementById('clearSearchBtn');
  const clearEmpNameBtn = document.getElementById('clearEmpNameBtn');
  
  // ドロップダウン機能の設定
  nameInput.addEventListener('focus', () => {
    if (!isDropdownActionInProgress) {
      showDropdown('empName', 'empNameDropdown');
      updateClearButton('empName', 'clearEmpNameBtn');
    }
  });
  
  nameInput.addEventListener('input', () => {
    if (!isDropdownActionInProgress) {
      updateButtons(nameInput.value.trim());
      showDropdown('empName', 'empNameDropdown');
      updateClearButton('empName', 'clearEmpNameBtn');
    }
  });
  
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      hideDropdown('empNameDropdown');
      nameInput.blur();
      e.preventDefault();
    }
  });
  
  searchInput.addEventListener('focus', () => {
    showDropdown('searchEmpName', 'searchEmpNameDropdown');
    updateClearButton('searchEmpName', 'clearSearchBtn');
  });
  
  searchInput.addEventListener('input', () => {
    if (!isDropdownActionInProgress) {
      displayEmpRecords();
      showDropdown('searchEmpName', 'searchEmpNameDropdown');
      updateClearButton('searchEmpName', 'clearSearchBtn');
    }
  });
  
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      hideDropdown('searchEmpNameDropdown');
      searchInput.blur();
      e.preventDefault();
    }
  });
  
  // クリアボタンのクリックイベント
  clearEmpNameBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    nameInput.value = '';
    clearEmpNameBtn.classList.remove('show');
    hideDropdown('empNameDropdown');
    updateButtons('');
    
    nameInput.focus();
  });
  
  clearSearchBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    searchInput.value = '';
    clearSearchBtn.classList.remove('show');
    hideDropdown('searchEmpNameDropdown');
    displayEmpRecords();
    
    searchInput.focus();
  });
  
  // 外部クリックでドロップダウンを閉じる
  document.addEventListener('click', (e) => {
    if (isDropdownActionInProgress) return;
    
    if (!e.target.closest('.input-wrapper')) {
      hideAllDropdowns();
    }
  });
  
  // ESCキーでドロップダウンとキーボードを閉じる
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideAllDropdowns();
      const activeElement = document.activeElement;
      if (activeElement && (activeElement.id === 'empName' || activeElement.id === 'searchEmpName')) {
        activeElement.blur();
      }
    }
  });
  
  // メニュートグル
  document.getElementById('toggleMenu').addEventListener('click', (e) => {
    const menu = document.getElementById('adminMenu');
    const toggle = document.getElementById('toggleMenu');
    const isOpen = menu.style.display === 'flex';
    
    if (isOpen) {
      menu.style.display = 'none';
      menu.classList.remove('show');
      toggle.classList.remove('active');
    } else {
      menu.style.display = 'flex';
      menu.classList.add('show');
      toggle.classList.add('active');
    }
  });

  // 出退勤ボタン
  btnClockIn.addEventListener('click', () => {
    saveEmpPair(nameInput.value.trim(), 'in');
  });

  btnClockOut.addEventListener('click', () => {
    saveEmpPair(nameInput.value.trim(), 'out');
  });
  
  // 手動同期ボタン
  document.getElementById('syncBtn').addEventListener('click', async () => {
    const syncBtn = document.getElementById('syncBtn');
    syncBtn.disabled = true;
    syncBtn.textContent = '同期中...';
    
    try {
      await firebaseSync.syncWithCloud();
      showAlert('同期完了', 'success');
    } catch (error) {
      showAlert('同期エラー', 'error');
      console.error('手動同期エラー:', error);
    } finally {
      syncBtn.disabled = false;
      syncBtn.textContent = 'クラウド同期';
    }
  });

  // 共有コード生成ボタン
  document.getElementById('generateCodeBtn').addEventListener('click', async () => {
    if (!firebaseSync.currentUser) {
      showAlert('認証が完了していません', 'error');
      return;
    }

    const shareCode = firebaseSync.currentUser.uid.substring(0, 8).toUpperCase();
    const message = `共有コード: ${shareCode}\n\n別デバイスで「共有コード入力」から入力してください。`;
    
    if (navigator.share) {
      try {
        await navigator.share({
          title: '勤怠管理 共有コード',
          text: message
        });
        showAlert('共有コード送信済み', 'success');
      } catch (error) {
        if (!error.name.includes('Abort')) {
          copyToClipboard(shareCode, message);
        }
      }
    } else {
      copyToClipboard(shareCode, message);
    }
  });

  // 共有コード入力ボタン
  document.getElementById('inputCodeBtn').addEventListener('click', () => {
    const code = prompt('共有コードを入力してください:');
    if (code) {
      connectToSharedAccount(code.toUpperCase());
    }
  });
  
  // バックアップボタン
  document.getElementById('backupBtn').addEventListener('click', async () => {
    const data = localStorage.getItem(STORAGE_KEY) || '{}';
    const now = new Date();
    const dateStr = now.toISOString().slice(0,10).replace(/-/g, '');
    const timeStr = now.toTimeString().slice(0,5).replace(/:/g, '');
    const filename = `勤怠データ_${dateStr}_${timeStr}.json`;
    
    if (navigator.share && navigator.canShare) {
      try {
        const blob = new Blob([data], { type: 'application/json' });
        const file = new File([blob], filename, { type: 'application/json' });
        
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({
            title: '勤怠管理バックアップ',
            text: '勤怠データのバックアップファイルです',
            files: [file]
          });
          showAlert('バックアップを共有しました', 'success');
          return;
        }
      } catch (error) {
        console.log('Share API error:', error);
        
        if (error.name === 'AbortError' || error.message.includes('cancel') || error.message.includes('abort')) {
          console.log('ユーザーがキャンセルしました');
          return;
        }
        
        console.log('Share API failed, falling back to download');
      }
    }
    
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); 
    a.href = url; 
    a.download = filename; 
    a.click(); 
    URL.revokeObjectURL(url);
    
    showAlert('バックアップファイルをダウンロードしました', 'success');
  });

  // リストアボタン
  document.getElementById('restoreBtn').addEventListener('click', () => {
    document.getElementById('restoreFile').click();
  });

  document.getElementById('restoreFile').addEventListener('change', e => {
    const reader = new FileReader(); 
    reader.onload = ev => {
      try {
        JSON.parse(ev.target.result);
        localStorage.setItem(STORAGE_KEY, ev.target.result);
        displayEmpRecords(); 
        updateButtons(nameInput.value.trim());
        showAlert('データを復元しました', 'success');
      } catch {
        showAlert('無効なデータ形式です', 'error');
      }
    }; 
    reader.readAsText(e.target.files[0]);
  });

  // 全データ削除ボタン
  document.getElementById('clearAllBtn').addEventListener('click', () => {
    const pwd = prompt('パスワードを入力してください:');
    if (pwd === '4564') {
      localStorage.removeItem(STORAGE_KEY);
      displayEmpRecords(); 
      updateButtons('');
      showAlert('全データを削除しました', 'success');
    } else if (pwd !== null) {
      showAlert('パスワードが違います', 'error');
    }
  });
  
  // 時計の初期化と更新
  updateClock();
  setInterval(updateClock, 1000);
  
  displayEmpRecords(); 
  updateButtons('');
  
  // 初期状態のクリアボタン表示制御
  updateClearButton('empName', 'clearEmpNameBtn');
  updateClearButton('searchEmpName', 'clearSearchBtn');
});
