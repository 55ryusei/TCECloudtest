const CACHE_NAME = 'timecard-v1';
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './logo.png',
  './icon-192.png',
  './icon-512.png'
];

// Service Worker のインストール
self.addEventListener('install', event => {
  console.log('Service Worker installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache.map(url => new Request(url, {cache: 'reload'})));
      })
      .catch(error => {
        console.log('Cache addAll failed:', error);
        // 一部のリソースが失敗してもインストールを続行
        return caches.open(CACHE_NAME)
          .then(cache => {
            const promises = urlsToCache.map(url => {
              return cache.add(new Request(url, {cache: 'reload'}))
                .catch(err => {
                  console.log(`Failed to cache ${url}:`, err);
                  // 個別のエラーは無視して続行
                });
            });
            return Promise.all(promises);
          });
      })
  );
  
  // 新しいService Workerを即座にアクティブ化
  self.skipWaiting();
});

// Service Worker のアクティベーション
self.addEventListener('activate', event => {
  console.log('Service Worker activating...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          // 古いキャッシュを削除
          if (cacheName !== CACHE_NAME) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      // すべてのクライアントを即座に制御下に置く
      return self.clients.claim();
    })
  );
});

// ネットワークリクエストの処理
self.addEventListener('fetch', event => {
  // HTMLファイルのリクエストを処理
  if (event.request.destination === 'document') {
    event.respondWith(
      caches.match('./')
        .then(response => {
          if (response) {
            return response;
          }
          return fetch(event.request)
            .then(response => {
              // 成功したレスポンスをキャッシュに保存
              if (response.status === 200) {
                const responseClone = response.clone();
                caches.open(CACHE_NAME)
                  .then(cache => {
                    cache.put(event.request, responseClone);
                  });
              }
              return response;
            })
            .catch(() => {
              // ネットワークが利用できない場合、キャッシュされたindex.htmlを返す
              return caches.match('./');
            });
        })
    );
    return;
  }

  // その他のリクエスト（画像、CSS、JS など）
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // キャッシュにある場合はそれを返す
        if (response) {
          return response;
        }

        // キャッシュにない場合はネットワークから取得
        return fetch(event.request)
          .then(response => {
            // 有効なレスポンスかチェック
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }

            // レスポンスをクローンしてキャッシュに保存
            const responseToCache = response.clone();
            caches.open(CACHE_NAME)
              .then(cache => {
                cache.put(event.request, responseToCache);
              });

            return response;
          })
          .catch(error => {
            console.log('Fetch failed:', error);
            
            // 画像リクエストが失敗した場合のフォールバック
            if (event.request.destination === 'image') {
              // SVGで作成したシンプルなプレースホルダー画像を返す
              const fallbackSvg = `
                <svg width="192" height="192" xmlns="http://www.w3.org/2000/svg">
                  <rect width="192" height="192" fill="#3b82f6"/>
                  <text x="96" y="110" font-family="Arial, sans-serif" font-size="48" 
                        fill="white" text-anchor="middle" font-weight="bold">勤</text>
                </svg>
              `;
              return new Response(fallbackSvg, {
                headers: {
                  'Content-Type': 'image/svg+xml',
                  'Cache-Control': 'no-cache'
                }
              });
            }
            
            // その他のリクエストエラーの場合
            throw error;
          });
      })
  );
});

// バックグラウンド同期（将来の拡張用）
self.addEventListener('sync', event => {
  console.log('Background sync triggered:', event.tag);
  
  if (event.tag === 'backup-timecard-data') {
    event.waitUntil(
      // バックグラウンドでのデータ同期処理
      // 現在はlocalStorageのみなので実装なし
      Promise.resolve()
    );
  }
});

// プッシュ通知（将来の拡張用）
self.addEventListener('push', event => {
  console.log('Push notification received:', event);
  
  const options = {
    body: event.data ? event.data.text() : '勤怠管理の通知',
    icon: './icon-192.png',
    badge: './icon-192.png',
    vibrate: [100, 50, 100],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: 1
    }
  };

  event.waitUntil(
    self.registration.showNotification('勤怠管理', options)
  );
});

// 通知クリック処理
self.addEventListener('notificationclick', event => {
  console.log('Notification clicked:', event);
  
  event.notification.close();
  
  event.waitUntil(
    clients.openWindow('./')
  );
});

// アプリケーションの更新チェック
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// エラーハンドリング
self.addEventListener('error', event => {
  console.error('Service Worker error:', event.error);
});

self.addEventListener('unhandledrejection', event => {
  console.error('Service Worker unhandled promise rejection:', event.reason);
});