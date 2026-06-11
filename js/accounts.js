// ── Account Switcher (Phase 6) ────────────────────────────────────────────────
// Global account filter shared by History, Dashboard and Portfolio. Accounts
// are discovered from the `v_accounts` view (any login that ever posted a
// trade or balance snapshot), so a new EA/account shows up here automatically
// after its first webhook hit — no code change needed.
//
// Selected value lives in localStorage: a login number as string, or 'ALL'.
// Default = real account, so demo trades never pollute real stats by accident.

const REAL_ACCOUNT = 87464504;

// Friendly names for known accounts; anything not listed shows as "#<login>".
const ACCOUNT_LABELS = {
  87464504: 'Real',
  49754423: 'WaveRider Demo',
};

function getSelectedAccount() {
  return localStorage.getItem('kp56_account') || String(REAL_ACCOUNT);
}
function setSelectedAccount(v) { localStorage.setItem('kp56_account', String(v)); }

function accountLabel(login) {
  return ACCOUNT_LABELS[login] || ('#' + login);
}

let knownAccounts = [];   // [{ account_login, last_seen, trades }]

async function initAccountBar() {
  const bar = document.getElementById('accountBar');
  if (!bar) return;
  try {
    const { data, error } = await db.from('v_accounts')
      .select('*').order('last_seen', { ascending: false });
    if (error) throw error;
    knownAccounts = data || [];
  } catch (err) {
    console.error('account bar load failed', err);
    return; // bar stays hidden; everything falls back to the default account
  }

  // If the saved selection points to an account that no longer exists, reset.
  const sel = getSelectedAccount();
  if (sel !== 'ALL' && !knownAccounts.some(a => String(a.account_login) === sel)) {
    setSelectedAccount(REAL_ACCOUNT);
  }

  // With a single account a switcher is just noise — keep the bar hidden.
  if (knownAccounts.length < 2) return;
  bar.style.display = '';
  renderAccountBar();
}

function renderAccountBar() {
  const bar = document.getElementById('accountBar');
  const sel = getSelectedAccount();
  const chips = knownAccounts.map(a => {
    const login = String(a.account_login);
    return `<button class="filter-btn ${sel === login ? 'active' : ''}"
              data-account="${login}">${accountLabel(a.account_login)}</button>`;
  });
  chips.push(`<button class="filter-btn ${sel === 'ALL' ? 'active' : ''}"
                data-account="ALL">All</button>`);
  bar.innerHTML = `<span class="account-bar-label">Account</span>` + chips.join('');
  bar.querySelectorAll('[data-account]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.account === getSelectedAccount()) return;
      setSelectedAccount(btn.dataset.account);
      renderAccountBar();
      refreshForAccountChange();
    });
  });
}

// Re-query whatever page is on screen with the new account filter.
function refreshForAccountChange() {
  const page = document.querySelector('.page.active')?.id;
  if (page === 'history') loadHistory();
  if (page === 'stats') { allDashboardData = []; loadDashboard(); loadPortfolio(); }
  // numerology page reads manual trade_ideas only — account-independent.
}

document.addEventListener('DOMContentLoaded', initAccountBar);
