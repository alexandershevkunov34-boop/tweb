import type Chat from '@components/chat/chat';
import type {AppImManager, ChatSetInnerPeerOptions} from '@lib/appImManager';
import {ChatType} from '@components/chat/chatType';
import ButtonIcon from '@components/buttonIcon';
import wrapPeerTitle from '@components/wrappers/peerTitle';
import Modes from '@config/modes';
import {isDesktopWmEnabled} from '@config/desktopWm';
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
  onPeerChanged: (chat: Chat) => void
};

type Interaction = 'move' | 'resize';

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
const BAR_HEIGHT = 32;

/**
 * The desktop: chats open in square windows which are moved by their bar (or by any point of
 * them with Alt held, as in a floating window manager) and resized by the corner. The window in
 * focus holds the chat which `appImManager.chat` is - the rest of the app reads that one.
 *
 * Coordinates are physical (`left` / `top` measured from the layer), as they come from the pointer.
 */
export default class ChatWindows {
  private layer: HTMLElement;
  private windows: ChatWindow[] = [];
  private zIndex = 0;
  private cascade = 0;
  private savedGeometry: {[peerId: string]: WindowGeometry};

  constructor(private appImManager: AppImManager) {
    this.layer = document.createElement('div');
    this.layer.classList.add('dwm-layer');
    // * right after the middle column, so the right one (when it floats) stays over the windows
    appImManager.columnEl.after(this.layer);

    try {
      this.savedGeometry = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch(err) {
      this.savedGeometry = {};
    }

    document.body.classList.toggle('desktop-wm-enabled', isDesktopWmEnabled());
    this.updateActive();
    mediaSizes.addEventListener('changeScreen', () => this.updateActive());
    window.addEventListener('resize', this.onResize);
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
    if(!active) {
      this.closeAll();
    }
  }

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
  }

  private getFocused() {
    return this.windows.find((win) => win.chat === this.appImManager.chat);
  }

  private updateFocusedClass() {
    const focused = this.getFocused();
    this.windows.forEach((win) => win.element.classList.toggle('is-focused', win === focused));
  }

  private focus(win: ChatWindow) {
    win.element.style.zIndex = '' + ++this.zIndex;
    this.appImManager.focusWindowChat(win.chat);
    this.updateFocusedClass();
  }

  private createWindow(chat: Chat, options: ChatSetInnerPeerOptions): ChatWindow {
    const element = document.createElement('div');
    element.classList.add('dwm-window');

    const bar = document.createElement('div');
    bar.classList.add('dwm-window__bar');

    const titleEl = document.createElement('div');
    titleEl.classList.add('dwm-window__title');

    const closeBtn = ButtonIcon('close dwm-window__close', {noRipple: true, ariaLabel: 'Close', asDiv: !Modes.a11y});

    const body = document.createElement('div');
    body.classList.add('dwm-window__body');
    body.append(chat.container);

    const resizer = document.createElement('div');
    resizer.classList.add('dwm-window__resizer');

    bar.append(titleEl, closeBtn);
    element.append(bar, body, resizer);

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

    // * a press anywhere in the window brings it up front; with Alt held it also moves the window
    element.addEventListener('pointerdown', (e) => {
      if(e.button !== 0) {
        return;
      }

      if(e.altKey) {
        e.stopPropagation();
        this.startInteraction(win, e, 'move');
        return;
      }

      if(this.getFocused() !== win) {
        this.focus(win);
      }
    }, {capture: true});

    bar.addEventListener('pointerdown', (e) => {
      if(e.button !== 0 || (e.target as HTMLElement).closest('.dwm-window__close')) {
        return;
      }

      this.startInteraction(win, e, 'move');
    });

    resizer.addEventListener('pointerdown', (e) => {
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
    });
  }

  private getInitialGeometry(options: Pick<ChatSetInnerPeerOptions, 'peerId'>): WindowGeometry {
    const rect = this.layer.getBoundingClientRect();
    const saved = this.savedGeometry[options.peerId];
    const offset = (this.cascade++ % CASCADE_STEPS) * CASCADE_STEP;
    const geometry = saved ? {...saved} : {
      x: (rect.width - DEFAULT_SIZE) / 2 + offset - CASCADE_STEP * CASCADE_STEPS / 2,
      y: Math.max(0, (rect.height - DEFAULT_SIZE) / 2) + offset - CASCADE_STEP * CASCADE_STEPS / 2,
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
      // * some of the window has to stay in sight, and its bar always, or it could not be got back
      x: clamp(geometry.x, KEEP_VISIBLE - width, rect.width - KEEP_VISIBLE),
      y: clamp(geometry.y, 0, Math.max(0, rect.height - BAR_HEIGHT))
    };
  }

  private applyGeometry(win: ChatWindow) {
    const {x, y, width, height} = win.geometry;
    const {style} = win.element;
    style.width = width + 'px';
    style.height = height + 'px';
    style.transform = `translate(${x}px, ${y}px)`;
  }

  private startInteraction(win: ChatWindow, e: PointerEvent, interaction: Interaction) {
    e.preventDefault();
    if(this.getFocused() !== win) {
      this.focus(win);
    }

    // * the layer's box is read once, not by every move
    const rect = this.layer.getBoundingClientRect();
    const start = {...win.geometry};
    const startX = e.clientX;
    const startY = e.clientY;
    win.element.classList.add('is-interacting');

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

      win.geometry = this.clampGeometry(next, rect);
      this.applyGeometry(win);
    };

    const onEnd = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onEnd);
      document.removeEventListener('pointercancel', onEnd);
      win.element.classList.remove('is-interacting');
      this.saveGeometry(win);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onEnd);
    document.addEventListener('pointercancel', onEnd);
  }

  private saveGeometry(win: ChatWindow) {
    const {peerId} = win.chat;
    if(!peerId) {
      return;
    }

    this.savedGeometry[peerId] = {...win.geometry};
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.savedGeometry));
    } catch(err) {}
  }

  private onResize = () => {
    const rect = this.layer.getBoundingClientRect();
    this.windows.forEach((win) => {
      win.geometry = this.clampGeometry(win.geometry, rect);
      this.applyGeometry(win);
    });
  };
}
