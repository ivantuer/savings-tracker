// Google Identity Services: loads Google's script on demand and renders the official sign-in button.
interface Gis {
  accounts: { id: {
    initialize(c: { client_id: string; callback: (r: { credential: string }) => void; auto_select?: boolean }): void;
    renderButton(el: HTMLElement, o: Record<string, unknown>): void;
  } };
}
declare global { interface Window { google?: Gis } }

let loading: Promise<Gis> | null = null;

export function loadGoogle(): Promise<Gis> {
  if (window.google?.accounts) return Promise.resolve(window.google);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => (window.google?.accounts ? resolve(window.google) : reject(new Error('Google sign-in did not load')));
    s.onerror = () => { loading = null; reject(new Error('Could not reach Google. Check your connection.')); };
    document.head.appendChild(s);
  });
  return loading;
}

export async function renderGoogleButton(el: HTMLElement, clientId: string, onCredential: (idToken: string) => void) {
  const g = await loadGoogle();
  g.accounts.id.initialize({ client_id: clientId, callback: (r) => onCredential(r.credential), auto_select: false });
  el.innerHTML = '';
  g.accounts.id.renderButton(el, { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', width: 280 });
}
