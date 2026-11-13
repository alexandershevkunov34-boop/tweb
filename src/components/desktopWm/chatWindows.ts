import type Chat from '@components/chat/chat';
import type {AppImManager, ChatSetInnerPeerOptions} from '@lib/appImManager';
import {ChatType} from '@components/chat/chatType';
import wrapPeerTitle from '@components/wrappers/peerTitle';
import Fog from '@components/desktopWm/fog';
import {isDesktopWmEnabled} from '@config/desktopWm';
import I18n from '@lib/langPack';
import mediaSizes from '@helpers/mediaSizes';
import clamp from '@helpers/number/clamp';

type WindowGeometry = {
  x: number,
  y: number,
  width: number,
  height: number
};

type ChatWindow = {
  element: HTMLElement,
  titleEl: HTMLElement,
  chat: Chat,
  geometry: WindowGeometry,
  // * where the window stood before the tiles took it, and before it was maximized
  floatGeometry?: WindowGeometry,
  maximizedFrom?: WindowGeometry,
  onPeerChanged: (chat: Chat) => void
};

type Interaction = 'move' | 'resize';
type Layout = 'float' | 'tile';

const STORAGE_KEY = 'desktop-wm-geometry';
// * a new window is a square
const DEFAULT_SIZE = 440;
const MIN_WIDTH = 300;
const MIN_HEIGHT = 320;
// * how far the next new window is moved from the previous one
const CASCADE_STEP = 32;
const CASCADE_STEPS = 8;
// * how much of a window's width has to stay on the desktop, and how much of its bar
const KEEP_VISIBLE = 64;
const TITLEBAR_HEIGHT = 24;
// * the gap between the tiles and the edge of the desktop, as in vxwm
const TILE_GAP = 8;
// * the share of the desktop the first tile takes when there are others beside it
const TILE_MASTER_SHARE = 0.55;

const CLOSE_ICON = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="square"><path d="M1 1l8 8M9 1L1 9"/></svg>';

const pad = (value: number) => ('' + value).padStart(2, '0');

/**
 * The desktop: chats open in square windows, as on the author's vxwm-style site. A window is moved
 * by its title (or by any point of it with Alt held), resized by the corner (or with Alt and the
 * right button) and closed by the cross. The bar on top lists the windows as tags, the `><>` /
 * `[]=` button lays them out floating or in tiles, and Alt+Space, Alt+M, Alt+Shift+C and Alt+1…9
 * do the same from the keyboard. The window in focus holds the chat which `appImManager.chat`
 * is - the rest of the app reads that one.
 *
 * Coordinates are physical (`left` / `top` measured from the layer), as they come from the pointer.
 */
export default class ChatWindows {
  private layer: HTMLElement;
  private bar: HTMLElement;
  private tagsEl: HTMLElement;
  private layoutBtn: HTMLButtonElement;
  private barTitle: HTMLElement;
  private clockEl: HTMLElement;
  private fog: Fog;
  private clockInterval: number;
  private windows: ChatWindow[] = [];
  private layout: Layout = 'float';
  private zIndex = 0;
  private cascade = 0;
  private savedGeometry: {[peerId: string]: WindowGeometry};

  constructor(private appImManager: AppImManager) {
    this.layer = document.createElement('div');
    this.layer.classList.add('dwm-layer');
    // * right after the middle column, so the right one (when it floats) stays over the windows
    appImManager.columnEl.after(this.layer);

    this.createBar();

    const fogCanvas = document.createElement('canvas');
    fogCanvas.classList.add('dwm-fog');
    document.body.prepend(fogCanvas);
    this.fog = new Fog(fogCanvas);

    try {
      this.savedGeometry = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch(err) {
      this.savedGeometry = {};
    }

    document.body.classList.toggle('desktop-wm-enabled', isDesktopWmEnabled());
    this.updateActive();
    mediaSizes.addEventListener('changeScreen', () => this.updateActive());
    window.addEventListener('resize', this.onResize);
    document.addEventListener('keydown', this.onKeyDown, true);
    // * Alt with the right button resizes, it must not open a menu
    this.layer.addEventListener('contextmenu', (e) => e.altKey && e.preventDefault());
  }

  /** Whether chats go to windows at the moment: not on a phone, nor where the left column is a drawer. */
  public isActive() {
    return isDesktopWmEnabled() && !mediaSizes.isMobile && !mediaSizes.isLessThanFloatingLeftSidebar;
  }

  public hasWindows() {
    return !!this.windows.length;
  }

  public has(chat: Chat) {
    return this.windows.some((win) => win.chat === chat);
  }

  private updateActive() {
    const active = this.isActive();
    document.body.classList.toggle('desktop-wm', active);
    // * the wallpaper of the chat is not the desktop's: the windows are white and the fog is behind them
    const background = this.appImManager.appChatBackground?.element;
    if(background) {
      background.style.display = active ? 'none' : '';
    }

    if(active) {
      this.fog.start();
      this.updateClock();
      this.clockInterval ||= window.setInterval(() => this.updateClock(), 1000);
    } else {
      this.fog.stop();
      clearInterval(this.clockInterval);
      this.clockInterval = 0;
      this.closeAll();
    }
  }

  // * the bar

  private createBar() {
    const bar = this.bar = document.createElement('div');
    bar.classList.add('dwm-bar');

    this.tagsEl = document.createElement('div');
    this.tagsEl.classList.add('dwm-tags');

    this.layoutBtn = document.createElement('button');
    this.layoutBtn.classList.add('dwm-bar__button', 'dwm-layout');
    this.layoutBtn.addEventListener('click', () => this.setLayout(this.layout === 'tile' ? 'float' : 'tile'));

    this.barTitle = document.createElement('div');
    this.barTitle.classList.add('dwm-bar__title');

    const status = document.createElement('div');
    status.classList.add('dwm-status');
    this.clockEl = document.createElement('span');
    this.clockEl.classList.add('dwm-clock');
    status.append(this.clockEl);

    bar.append(this.tagsEl, this.layoutBtn, this.barTitle, status);
    document.body.append(bar);
    this.updateBar();
  }

  private updateClock() {
    const now = new Date();
    this.clockEl.textContent = `${pad(now.getDate())}.${pad(now.getMonth() + 1)} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  private updateBar() {
    const focused = this.getFocused();
    this.layoutBtn.textContent = this.layout === 'tile' ? '[]=' : '><>';
    this.layoutBtn.title = 'Alt+Space';

    // * a tag for each window, in the order they were opened
    this.tagsEl.replaceChildren(...this.windows.map((win, index) => {
      const tag = document.createElement('button');
      tag.classList.add('dwm-bar__button', 'dwm-tag', 'is-occupied');
      tag.classList.toggle('is-selected', win === focused);
      tag.textContent = '' + (index + 1);
      tag.title = win.titleEl.textContent;
      tag.addEventListener('click', () => this.focus(win));
      return tag;
    }));

    this.barTitle.textContent = focused ? focused.titleEl.textContent : 'vxwm';
    this.barTitle.classList.toggle('is-focused', !!focused);
  }

  // * windows

  public async open(options: ChatSetInnerPeerOptions) {
    options.type ??= ChatType.Chat;
    const {appImManager} = this;

    const existing = this.windows.find((win) => appImManager.isSamePeer(win.chat, options));
    if(existing) {
      this.focus(existing);
      await existing.chat.setPeer(options as any as Parameters<Chat['setPeer']>[0]);
      return true;
    }

    const chat = appImManager.createWindowChat();
    const win = this.createWindow(chat, options);
    this.windows.push(win);
    this.layer.append(win.element);
    // * the window is laid out before the chat starts to render in it
    this.applyGeometry(win);
    chat.container.classList.add('active');
    this.focus(win);
    this.layout === 'tile' && this.tile();

    try {
      await chat.setPeer(options as any as Parameters<Chat['setPeer']>[0]);
    } catch(err) {
      this.close(win);
      throw err;
    }

    return true;
  }

  public close(win: ChatWindow) {
    const index = this.windows.indexOf(win);
    if(index === -1) {
      return;
    }

    this.windows.splice(index, 1);
    this.appImManager.removeEventListener('peer_changed', win.onPeerChanged);
    win.element.remove();
    this.appImManager.destroyWindowChat(win.chat);
    this.layout === 'tile' && this.tile();
    this.updateFocusedClass();
  }

  public closeByChat(chat: Chat) {
    const win = this.windows.find((win) => win.chat === chat);
    win && this.close(win);
  }

  public closeFocused() {
    const win = this.getFocused();
    win && this.close(win);
  }

  public closeAll() {
    [...this.windows].forEach((win) => this.close(win));
  }

  /** The chats are already gone (an account switch destroys them): only what is drawn is left to remove. */
  public reset() {
    this.windows.forEach((win) => {
      this.appImManager.removeEventListener('peer_changed', win.onPeerChanged);
      win.element.remove();
    });
    this.windows.length = 0;
    this.updateBar();
  }

  private getFocused() {
    return this.windows.find((win) => win.chat === this.appImManager.chat);
  }

  private updateFocusedClass() {
    const focused = this.getFocused();
    this.windows.forEach((win) => win.element.classList.toggle('is-focused', win === focused));
    this.updateBar();
  }

  private focus(win: ChatWindow) {
    win.element.style.zIndex = '' + ++this.zIndex;
    this.appImManager.focusWindowChat(win.chat);
    this.updateFocusedClass();
    // * the first tile is the one in focus
    this.layout === 'tile' && this.tile();
  }

  private createWindow(chat: Chat, options: ChatSetInnerPeerOptions): ChatWindow {
    const element = document.createElement('section');
    element.classList.add('dwm-win');

    const titlebar = document.createElement('header');
    titlebar.classList.add('dwm-titlebar');

    const titleEl = document.createElement('span');
    titleEl.classList.add('dwm-ttl');

    const closeBtn = document.createElement('button');
    closeBtn.classList.add('dwm-close');
    closeBtn.setAttribute('aria-label', I18n.format('Close', true));
    closeBtn.innerHTML = CLOSE_ICON;

    const body = document.createElement('div');
    body.classList.add('dwm-body');
    body.append(chat.container);

    const grip = document.createElement('div');
    grip.classList.add('dwm-grip');

    titlebar.append(titleEl, closeBtn);
    element.append(titlebar, body, grip);

    const win: ChatWindow = {
      element,
      titleEl,
      chat,
      geometry: this.getInitialGeometry(options),
      onPeerChanged: (changed) => {
        if(changed === chat) {
          this.updateTitle(win);
        }
      }
    };

    this.appImManager.addEventListener('peer_changed', win.onPeerChanged);
    this.updateTitle(win, options);

    // * a press anywhere in the window brings it up front; with Alt held it also moves or resizes it
    element.addEventListener('pointerdown', (e) => {
      if(e.altKey && (e.button === 0 || e.button === 2)) {
        e.stopPropagation();
        this.startInteraction(win, e, e.button === 2 ? 'resize' : 'move');
        return;
      }

      if(e.button === 0 && this.getFocused() !== win) {
        this.focus(win);
      }
    }, {capture: true});

    titlebar.addEventListener('pointerdown', (e) => {
      if(e.button !== 0 || (e.target as HTMLElement).closest('.dwm-close')) {
        return;
      }

      this.startInteraction(win, e, 'move');
    });

    grip.addEventListener('pointerdown', (e) => {
      if(e.button === 0) {
        this.startInteraction(win, e, 'resize');
      }
    });

    closeBtn.addEventListener('click', () => this.close(win));

    return win;
  }

  private updateTitle(win: ChatWindow, options?: Pick<ChatSetInnerPeerOptions, 'peerId' | 'threadId'>) {
    const peerId = win.chat.peerId || options?.peerId;
    if(!peerId) {
      return;
    }

    wrapPeerTitle({peerId, threadId: win.chat.threadId ?? options?.threadId, dialog: true}).then((title) => {
      win.titleEl.replaceChildren(title);
      this.updateBar();
    });
  }

  // * geometry

  private getInitialGeometry(options: Pick<ChatSetInnerPeerOptions, 'peerId'>): WindowGeometry {
    const rect = this.layer.getBoundingClientRect();
    const saved = this.savedGeometry[options.peerId];
    const offset = (this.cascade++ % CASCADE_STEPS) * CASCADE_STEP - CASCADE_STEP * CASCADE_STEPS / 2;
    const geometry = saved ? {...saved} : {
      x: (rect.width - DEFAULT_SIZE) / 2 + offset,
      y: Math.max(0, (rect.height - DEFAULT_SIZE) / 2) + offset,
      width: DEFAULT_SIZE,
      height: DEFAULT_SIZE
    };

    return this.clampGeometry(geometry, rect);
  }

  private clampGeometry(geometry: WindowGeometry, rect: DOMRect): WindowGeometry {
    const width = clamp(geometry.width, MIN_WIDTH, Math.max(MIN_WIDTH, rect.width));
    const height = clamp(geometry.height, MIN_HEIGHT, Math.max(MIN_HEIGHT, rect.height));
    return {
      width,
      height,
      // * some of the window has to stay in sight, and its title always, or it could not be got back
      x: clamp(geometry.x, KEEP_VISIBLE - width, rect.width - KEEP_VISIBLE),
      y: clamp(geometry.y, 0, Math.max(0, rect.height - TITLEBAR_HEIGHT))
    };
  }

  private applyGeometry(win: ChatWindow) {
    const {x, y, width, height} = win.geometry;
    const {style} = win.element;
    style.width = width + 'px';
    style.height = height + 'px';
    style.transform = `translate(${x}px, ${y}px)`;
  }

  private place(win: ChatWindow, geometry: WindowGeometry) {
    win.geometry = geometry;
    this.applyGeometry(win);
  }

  // * layouts

  private setLayout(layout: Layout) {
    if(layout === this.layout) {
      return;
    }

    this.windows.forEach((win) => this.unmaximize(win, false));
    this.layout = layout;
    if(layout === 'tile') {
      this.windows.forEach((win) => win.floatGeometry ||= {...win.geometry});
      this.tile();
    } else {
      this.windows.forEach((win) => {
        if(win.floatGeometry) {
          this.place(win, win.floatGeometry);
          win.floatGeometry = undefined;
        }
      });
    }

    this.updateBar();
  }

  /** The window in focus takes the left part of the desktop, the others share the right one. */
  private tile() {
    if(!this.windows.length) {
      return;
    }

    const focused = this.getFocused();
    const wins = [...this.windows].sort((a, b) => a === focused ? -1 : b === focused ? 1 : 0);
    const rect = this.layer.getBoundingClientRect();
    const x = TILE_GAP;
    const y = TILE_GAP;
    const width = rect.width - TILE_GAP * 2;
    const height = rect.height - TILE_GAP * 2;
    wins.forEach((win) => this.unmaximize(win, false));

    if(wins.length === 1) {
      this.place(wins[0], {x, y, width, height});
      return;
    }

    const masterWidth = width * TILE_MASTER_SHARE - TILE_GAP / 2;
    const stackWidth = width - masterWidth - TILE_GAP;
    this.place(wins[0], {x, y, width: masterWidth, height});

    const rest = wins.slice(1);
    const stackHeight = (height - TILE_GAP * (rest.length - 1)) / rest.length;
    rest.forEach((win, index) => {
      this.place(win, {x: x + masterWidth + TILE_GAP, y: y + index * (stackHeight + TILE_GAP), width: stackWidth, height: stackHeight});
    });
  }

  private toggleMaximized(win: ChatWindow) {
    if(win.maximizedFrom) {
      this.unmaximize(win, true);
      return;
    }

    const rect = this.layer.getBoundingClientRect();
    win.maximizedFrom = {...win.geometry};
    win.element.classList.add('is-maxed');
    this.place(win, {x: 0, y: 0, width: rect.width, height: rect.height});
  }

  private unmaximize(win: ChatWindow, restore: boolean) {
    if(!win.maximizedFrom) {
      return;
    }

    const from = win.maximizedFrom;
    win.maximizedFrom = undefined;
    win.element.classList.remove('is-maxed');
    restore && this.place(win, from);
  }

  // * pointer and keyboard

  private startInteraction(win: ChatWindow, e: PointerEvent, interaction: Interaction) {
    e.preventDefault();
    if(win.maximizedFrom) {
      return;
    }

    if(this.getFocused() !== win) {
      this.focus(win);
    }

    // * moving or resizing a tile sets the windows free, where they stand
    if(this.layout === 'tile') {
      this.windows.forEach((other) => other.floatGeometry = undefined);
      this.layout = 'float';
      this.updateBar();
    }

    // * the layer's box is read once, not by every move
    const rect = this.layer.getBoundingClientRect();
    const start = {...win.geometry};
    const startX = e.clientX;
    const startY = e.clientY;
    win.element.classList.add('is-interacting');
    document.body.classList.add('dwm-dragging');

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const next = {...start};
      if(interaction === 'move') {
        next.x += dx;
        next.y += dy;
      } else {
        next.width += dx;
        next.height += dy;
      }

      this.place(win, this.clampGeometry(next, rect));
    };

    const onEnd = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onEnd);
      document.removeEventListener('pointercancel', onEnd);
      win.element.classList.remove('is-interacting');
      document.body.classList.remove('dwm-dragging');
      this.saveGeometry(win);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onEnd);
    document.addEventListener('pointercancel', onEnd);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if(!e.altKey || e.ctrlKey || e.metaKey || !this.isActive()) {
      return;
    }

    const focused = this.getFocused();
    const digit = /^Digit([1-9])$/.exec(e.code);
    if(e.code === 'Space') {
      this.setLayout(this.layout === 'tile' ? 'float' : 'tile');
    } else if(e.code === 'KeyM' && !e.shiftKey && focused) {
      this.layout === 'float' && this.toggleMaximized(focused);
    } else if(e.code === 'KeyC' && e.shiftKey && focused) {
      this.close(focused);
    } else if(digit && !e.shiftKey && this.windows[+digit[1] - 1]) {
      this.focus(this.windows[+digit[1] - 1]);
    } else {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
  };

  private saveGeometry(win: ChatWindow) {
    const {peerId} = win.chat;
    if(!peerId || win.maximizedFrom) {
      return;
    }

    this.savedGeometry[peerId] = {...win.geometry};
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.savedGeometry));
    } catch(err) {}
  }

  private onResize = () => {
    if(this.layout === 'tile') {
      this.tile();
      return;
    }

    const rect = this.layer.getBoundingClientRect();
    this.windows.forEach((win) => {
      if(win.maximizedFrom) {
        this.place(win, {x: 0, y: 0, width: rect.width, height: rect.height});
      } else {
        this.place(win, this.clampGeometry(win.geometry, rect));
      }
    });
  };
}
