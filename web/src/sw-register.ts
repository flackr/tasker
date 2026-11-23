interface SyncManagerLike {
  register(tag: string): Promise<void>;
}

interface ServiceWorkerRegistrationWithSync extends ServiceWorkerRegistration {
  sync?: SyncManagerLike;
}

export function registerServiceWorker(onFlushRequested: () => void): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }

  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'CALDAV_FLUSH') {
      onFlushRequested();
    }
  });

  navigator.serviceWorker.register('./sw.js').catch(() => {
    // Service worker registration may be blocked in tests or insecure origins
  });
}

export async function requestBackgroundFlush(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }
  try {
    const registration = (await navigator.serviceWorker
      .ready) as ServiceWorkerRegistrationWithSync;
    if (registration.sync) {
      await registration.sync.register('caldav-flush');
    }
  } catch {
    // Background Sync API is optional across browsers
  }
}
