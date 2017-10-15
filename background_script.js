
const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = MINUTE * 60;

const config = [
  {
    url: 'http://google.com',
    revolve: 4 * SECOND,
    refresh: 10 * SECOND,
    schedule: {
      days: ['mon', 'tue', 'wed', 'thur', 'fri', 'sun'],
      open: '06:00',
      close: '14:43'
    }
  },
  {
    url: 'http://store/',
    revolve: 4 * SECOND,
  }
];

class WallboardWindow {
  constructor(opts) {
    this.cwindow = opts.cwindow;
  }

  focus() {
    chrome.windows.update(this.cwindow.id, { focused: true });
  }

  getTabs() {
    return new Promise(resolve => {
      chrome.tabs.query({ windowId: this.cwindow.id }, tabs => {
        resolve(tabs)
      });
    })
  }

  getId() {
    return this.cwindow.id;
  }

  closeTabs(tabIds) {
    return new Promise(resolve => chrome.tabs.remove(tabIds, () => resolve()));
  }

  newTab(url) {
    return new Promise(resolve => {
      chrome.tabs.create({ windowId: this.cwindow.id, url }, resolve);
    });
  }

  focusTab(tabId) {
    return new Promise(resolve => {
      chrome.tabs.update(tabId, { active: true }, resolve);
    });
  }

  reloadTab(tabId) {
    return new Promise(resolve => {
      chrome.tabs.reload(tabId, undefined, resolve);
    })
  }

  static create() {
    return new Promise(resolve => {
      chrome.windows.create({ }, cwindow => resolve(new WallboardWindow({ cwindow })));
    })
  }
}


class Wallboard {
  constructor(opts) {
    this.window = opts.window;
    this.config = opts.config;
    this.ticker = null;
    this.plugins = opts.plugins;
  }

  start() {
    this.ticker = window.setInterval(() => this.tick(), 1000);
    this.plugins.forEach(p => p.start());
  }

  stop() {
    window.clearInterval(this.ticker);
    this.plugins.forEach(p => p.stop());
  }

  tick() {
    this.plugins.forEach(p => p.tick());
  }
}

class Revolver {
  constructor(opts) {
    this.config = opts.config;
    this.tabRegistry = opts.tabRegistry;
    this.window = opts.window;

    this.defaultRevolveTime = 30 * SECOND;
    this.lastRevolveTime = new Date();
  }

  tick() {
    // Get active tab
    // Determine associated entry.
    // Check how much time passed since last revolve.
    //  if > tab time, revolve to next tab.
    const now = new Date();

    this.window.getTabs()
      .then(tabs => {
        const activeTab = tabs.find(t => t.active);
        const entry = this.tabRegistry.get(activeTab.id);
        const revolveTime = entry && entry.revolve ? entry.revolve : this.defaultRevolveTime;
        if ((this.lastRevolveTime.getTime() / 1000) + revolveTime < now.getTime() / 1000) {
          const activeIndex = tabs.indexOf(activeTab);
          this.lastRevolveTime = now;

          const nextTab = tabs[(activeIndex + 1) % tabs.length];
          this.window.focusTab(nextTab.id);
        }
      });
  }

  start() {}
  stop() {}
}

class Refresher {
  constructor(opts) {
    this.config = opts.config;
    this.window = opts.window;
    this.tabRegistry = opts.tabRegistry;

    this.defaultRefreshTime = HOUR * 6;
    this.tabsLastRefreshed = new Map();
  }

  tick() {
    // Get all tabs.
    // Remove any refresh time entries that no longer have associated tabs.
    // Get associated entry, get refresh time (or default)
    // If we are overdue for the tab, refresh it.
    this.window.getTabs()
      .then(tabs => {
        this.cleanupTimers(tabs.map(t => t.id));
        return tabs;
      })
      .then(tabs => tabs.forEach(tab => this.maybeRefreshTab(tab)))
  }

  cleanupTimers(tabIds) {
    [...this.tabsLastRefreshed.keys()]
      .filter(tabId => tabIds.indexOf(tabId) === -1)
      .forEach(tabId => this.tabsLastRefreshed.delete(tabId));
  }

  maybeRefreshTab(tab) {
    const now = new Date();
    const lastRefreshTime = this.tabsLastRefreshed.get(tab.id);
    if (lastRefreshTime) {
      const entry = this.tabRegistry.get(tab.id);
      const entryRefreshTime = entry && entry.refresh ? entry.refresh : this.defaultRefreshTime;

      const nextRefresh = (lastRefreshTime.getTime() / 1000) + entryRefreshTime;
      if (nextRefresh < now.getTime() / 1000) {
        this.tabsLastRefreshed.set(tab.id, now);
        this.window.reloadTab(tab.id);
      }
    } else {
      this.tabsLastRefreshed.set(tab.id, now);
    }
  }

  start() {}
  stop() {}

}

/**
 * In charge of opening tabs on a schedule and on a permanent basis.
 */
class TabOpener {
  constructor(opts) {
    this.config = opts.config;
    this.window = opts.window;
    this.tabRegistry = opts.tabRegistry;
  }

  start() {
    // Initially open all tabs that are applicable in the schedule.
    const toOpen = this.config.filter(entry => TabOpener.isApplicable(entry));
    this.openEntries(toOpen);
  }

  stop() {}

  tick() {
    // Find Entries that _should_ be open
    // Find entries that _should_ not be open.
    // Get all open tabs -> resolve open tabs to entries.
    // Partition:
      //  Tabs to close: Tabs who have no entry OR should not be open
      //  Tabs to keep: Tabs who have entry who is open.
      //

    const openEntries = this.config.filter(entry => TabOpener.isApplicable(entry));
    this.window.getTabs()
      .then(openTabs => openTabs.filter(t => !t.url.startsWith('chrome://')))
      .then(openTabs => openTabs.map(t => ({
        tabId: t.id,
        entry: this.tabRegistry.get(t.id)
      })))
      .then(openTabs => {
        const toClose = openTabs.filter(t => !t.entry || openEntries.indexOf(t.entry) === -1)
        const openTabEntries = openTabs.map(t => t.entry);
        const toOpen = openEntries.filter(entry => openTabEntries.indexOf(entry) === -1)
        return { toOpen, toClose };
      })
      .then(({ toOpen, toClose }) => {
        this.openEntries(toOpen).then(() => {
          this.closeTabs(toClose.map(t => t.tabId));
        });
      });
  }

  closeTabs(tabIds) {
    return this.window.closeTabs(tabIds)
      .then(() => {
        tabIds.forEach(id => this.tabRegistry.delete(id));
      });
  }

  openEntries(entries) {
    // Open a new tab, but also check for any existing chrome:// tabs. Close them
    // once the new tab is opened.
    return this.getPlaceholderTabs()
      .then(tabsToClose => {
        return Promise.all([
          Promise.resolve(tabsToClose),
          ...entries.map(entry => this.openEntry(entry))
        ]);
      })
      .then(([tabsToClose,]) => this.window.closeTabs(tabsToClose.map(t => t.id)));
  }

  getPlaceholderTabs() {
    return this.window.getTabs()
      .then(tabs => tabs.filter(t => t.url.startsWith('chrome://')));
  }

  openEntry(entry) {
    return this.window.newTab(entry.url)
      .then(tab => this.tabRegistry.set(tab.id, entry));
  }

  openPlaceholder() {
    return this.window.newTab('chrome://newtab');
  }

  static isApplicable(tabEntry) {
    const now = new Date()
    return TabOpener.applicableForDay(now, tabEntry) &&
      TabOpener.applicableForTime(now, tabEntry);
  }

  static applicableForDay(date, entry) {
    if (!entry.schedule || !entry.schedule.days) {
      return true;
    }

    const applicableDays = entry.schedule.days.map(day => TabOpener.toJsDay(day));
    return applicableDays.indexOf(date.getDay()) >= 0
  }

  static applicableForTime(date, entry) {
    if (!entry.schedule || !entry.schedule.open || !entry.schedule.close) {
      return true;
    }

    const [openHours, openMinutes] = entry.schedule.open.split(':');
    const openDate = new Date(date.getTime());
    openDate.setHours(openHours);
    openDate.setMinutes(openMinutes);

    if (date < openDate) {
      return false;
    }

    const [closeHours, closeMinutes] = entry.schedule.close.split(':');
    const closeDate = new Date(date.getTime());
    closeDate.setHours(closeHours);
    closeDate.setMinutes(closeMinutes);

    if (date > closeDate) {
      return false
    }

    return true;
  }

  static toJsDay(day) {
    const days = ['sun', 'mon', 'tue', 'wed', 'thur', 'fri', 'sat'];
    return days.indexOf(day);
  }
}

let activeWallboard = null;

function onWindowRemoved(windowId) {

  if (activeWallboard && activeWallboard.window.getId() === windowId) {
    activeWallboard.stop();
    activeWallboard = null;
  }
}

function newWallboard() {
  // If activeWallboard exists, just focus it.
  if (activeWallboard) {
    activeWallboard.window.focus();
    return;
  }

  WallboardWindow.create().then(window => {
    const tabRegistry = new Map();
    const revolver = new Revolver({ window, config, tabRegistry });
    const opener = new TabOpener({ window, config, tabRegistry });
    const refresher = new Refresher({ window, config, tabRegistry });
    activeWallboard = new Wallboard({
      window, config,
      plugins: [ revolver, opener, refresher ],
    });
    activeWallboard.start();
  })
}

chrome.windows.onRemoved.addListener(onWindowRemoved);
chrome.browserAction.onClicked.addListener(newWallboard);
newWallboard();
