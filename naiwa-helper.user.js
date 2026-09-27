// ==UserScript==
// @name         奶蛙快跑 · 辅助面板 (无敌 / 无限金币 / 全解锁)
// @name:en      Naiwa Run Helper
// @namespace    https://naiwa-kuaipao.pages.dev/
// @version      1.0.0
// @description  奶蛙快跑（自研 three.js 跑酷）纯前端辅助面板：永久无敌、金币磁铁、满护盾、一键刷金币、解锁全部 73 套服装。Alt+X 显示/隐藏面板。
// @description:en  Client-side helper panel for Naiwa Run (three.js endless runner): permanent invincibility, coin magnet, max shields, quick coin farming, unlock all 73 outfits. Press Alt+X to toggle the panel.
// @author       iu6888
// @license      MIT
// @match        https://naiwa-kuaipao.pages.dev/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/*
 * ── 原理 ─────────────────────────────────────────────────────────────────────
 * 目标游戏的每帧状态机里，只有两个地方决定"受伤/被抓"（以 engine.js 的
 * RunnerCore.Game 为准，改版后行号可能变化，关键字不变）：
 *
 *   step() 碰撞判定：
 *       if (!safe && this.invincible <= 0) { o.hit = true; this.hit(); ... }
 *   hit() 受伤判定：
 *       if (this.invincible > 0) return;              // 直接短路
 *       if (this.shield > 0) { ... return; }
 *       if (this.hurt > 0) { this.status = "over" }   // 第一次撞 hurt=7s，7 秒内再撞 = 被抓
 *   金币吸附：
 *       const pull = o.type === "coin" && this.magnet > 0;   // dx<7, |y+.85-o.y|<5
 *   每帧衰减：
 *       for (const k of ["slide","hurt","invincible","magnet"]) this[k] = Math.max(0, this[k]-dt);
 *
 *   → Math.max(0, Infinity - dt) === Infinity，所以写入 Infinity 之后【永不衰减】。
 *   → reset() 每次开局会把 invincible / magnet / shield 抹零，因此必须 Hook reset()。
 *
 * ── 数据归属 ─────────────────────────────────────────────────────────────────
 *   金币 / 服装：localStorage["sunny-run-v4-profile"]（纯本地，无服务端校验）
 *   云端：只有「最远距离」会上报 /api/finish，且【仅普通模式】才发请求。
 *        本脚本默认把联动云端的场景排除在外：刷金币请用「简单 / 困难」。
 */

(function () {
  "use strict";

  /* ══════════════════════════ 配置 ══════════════════════════ */
  const STATE = {
    invincible: true, // 永久无敌（永不掉血、永不被抓）
    magnet: true,     // 永久金币磁铁（自动吸附附近金币）
    shield: true,     // 满护盾 3 层
    panel: true,      // 是否显示面板
  };

  const PROFILE_KEY = "sunny-run-v4-profile";
  const MAX_SHIELD = 3;          // 对应 CONFIG.maxShields
  const MAGNET_SECONDS = 12;     // 游戏自身的磁铁时长；由 500ms ticker 持续续杯
  const POLL_MS = 200;
  const READY_TIMEOUT = 90000;

  /* ══════════════════════════ 核心补丁 ══════════════════════════ */

  const $game = () => (window.gameDebug && window.gameDebug.game) || null;
  const $view = () => {
    try { return window.gameDebug ? window.gameDebug.snapshot().view : null; } catch (e) { return null; }
  };

  function applyTo(g) {
    if (!g) return;
    if (STATE.invincible) {
      g.invincible = Infinity;
      g.hurt = 0;             // 清掉"追兵"计时
    }
    if (STATE.magnet) {
      // 这里刻意不用 Infinity：游戏的 HUD 会渲染 Math.ceil(magnet) + "s"，
      // Infinity 会显示成 "Infinitys"。而磁铁吸附只看 magnet > 0、不看数值大小，
      // 所以续杯成游戏自身的时长即可，HUD 看起来也正常。
      g.magnet = MAGNET_SECONDS;
    }
    if (STATE.shield && g.shield < MAX_SHIELD) {
      g.shield = MAX_SHIELD;
    }
  }

  const apply = () => applyTo($game());

  function patch(Game) {
    if (Game.prototype.__naiwaHelper) return false;
    Game.prototype.__naiwaHelper = true;

    const _reset = Game.prototype.reset;
    const _hit = Game.prototype.hit;

    // 每次 start() → game.reset() 之后自动重新上状态
    Game.prototype.reset = function (seed, difficulty) {
      _reset.call(this, seed, difficulty);
      applyTo(this);
      return this;
    };

    // 兜底：即使判定漏过来，任何命中也不生效
    Game.prototype.hit = function () {
      if (STATE.invincible) {
        this.invincible = Infinity;
        this.hurt = 0;
        return;
      }
      return _hit.apply(this, arguments);
    };

    return true;
  }

  /* ══════════════════════════ 开关（立即可见） ══════════════════════════ */

  function setInvincible(on) {
    STATE.invincible = on;
    const g = $game();
    if (!g) return;
    if (on) { g.invincible = Infinity; g.hurt = 0; } else { g.invincible = 0; }
  }

  function setMagnet(on) {
    STATE.magnet = on;
    const g = $game();
    if (g) g.magnet = on ? MAGNET_SECONDS : 0;
  }

  function setShield(on) {
    STATE.shield = on;
    const g = $game();
    if (g) g.shield = on ? MAX_SHIELD : 0;
  }

  /* ══════════════════════════ 金币 / 存档操作 ══════════════════════════ */

  // 本局直接加钱并走游戏自己的结算流程写入钱包（不刷新页面）
  function bankCoins(amount) {
    const g = $game();
    if (!g) return toast("游戏还没加载完");

    const view = $view();
    if (!["running", "paused", "over"].includes(view)) {
      return toast("请先「点击开跑」，或使用下面的「金币拉满 + 全解锁」");
    }
    if (view === "running" && g.time < 0.2) {
      return toast("刚起跑，等跑出 1 秒再点，否则结算会被跳过");
    }

    g.coins += amount;
    // home() 内部：if (["running","paused","over"].includes(view)) bankRun();
    // bankRun() → wardrobeStore.bankRun(game) → 写入 localStorage
    window.gameDebug.home();
    toast("已 +" + amount.toLocaleString() + " 金币，并结算进钱包");
    syncUI();
  }

  // 直接改存档：金币拉满 + 解锁全部服装（需刷新才生效，因为存档只在上电时读一次）
  function maxOutSave() {
    let p = {};
    try {
      p = JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}") || {};
    } catch (e) { p = {}; }

    const catalog = (window.CHARACTER_ASSETS && window.CHARACTER_ASSETS.catalog) || [];
    const ids = ["classic"].concat(catalog.map((o) => o.id));

    p.coins = 99999999;
    p.totalCoins = 99999999;
    p.ownedOutfits = ids;
    if (typeof p.best !== "number") p.best = 0;

    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
    } catch (e) {
      return toast("存档写入失败：" + e.message);
    }
    toast("已写入 " + ids.length + " 套服装 + 99,999,999 金币，正在刷新…");
    setTimeout(() => location.reload(), 700);
  }

  function resetSave() {
    try {
      localStorage.removeItem(PROFILE_KEY);
      localStorage.removeItem("naiwa-difficulty");
      localStorage.removeItem("naiwa-selected-map");
    } catch (e) { /* ignore */ }
    toast("已清空本机存档，正在刷新…");
    setTimeout(() => location.reload(), 700);
  }

  /* ══════════════════════════ 面板 UI（Shadow DOM 隔离） ══════════════════════════ */

  let ui = null;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
    .card {
      width: 236px; background: rgba(22, 26, 32, .93); color: #e8edf4;
      border: 1px solid rgba(255,255,255,.14); border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,.45); overflow: hidden;
      backdrop-filter: blur(10px); font-size: 12.5px; line-height: 1.45;
    }
    .hd {
      display: flex; align-items: center; gap: 6px; padding: 9px 10px;
      background: linear-gradient(135deg, #2b3542 0%, #1b2028 100%);
      border-bottom: 1px solid rgba(255,255,255,.1); cursor: default;
    }
    .hd b { flex: 1; font-size: 13px; letter-spacing: .3px; color: #9fe870; }
    .hd button {
      all: unset; cursor: pointer; width: 22px; height: 22px; line-height: 22px;
      text-align: center; border-radius: 6px; color: #aab4c0; font-size: 14px;
    }
    .hd button:hover { background: rgba(255,255,255,.12); color: #fff; }
    .bd { padding: 8px 10px 10px; }
    .bd.collapsed { display: none; }
    .sec { margin: 8px 0 4px; font-size: 11px; color: #7d8894; letter-spacing: .6px; }
    .row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 5px 0;
    }
    .sw {
      position: relative; width: 36px; height: 20px; border-radius: 10px;
      background: #39424e; transition: background .16s; cursor: pointer; flex: none;
    }
    .sw::after {
      content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
      border-radius: 50%; background: #fff; transition: transform .16s;
    }
    .sw.on { background: #2fa84f; }
    .sw.on::after { transform: translateX(16px); }
    .btn {
      all: unset; display: block; width: 100%; text-align: center; cursor: pointer;
      padding: 7px 8px; margin-top: 5px; border-radius: 8px; font-size: 12.5px;
      background: #2c3542; color: #dbe3ec;
      border: 1px solid rgba(255,255,255,.08); transition: filter .12s;
    }
    .btn:hover { filter: brightness(1.25); }
    .btn.ok { background: #235c37; color: #d6ffe3; }
    .btn.warn { background: #5c2a2a; color: #ffd9d9; }
    .ft { margin-top: 9px; padding-top: 7px; border-top: 1px solid rgba(255,255,255,.08);
          font-size: 11px; color: #7d8894; }
    .toast {
      position: fixed; left: 50%; top: 16px; transform: translateX(-50%);
      background: rgba(20,24,30,.95); color: #eaf2ff; padding: 8px 14px;
      border-radius: 9px; border: 1px solid rgba(255,255,255,.16);
      font-size: 12.5px; white-space: nowrap; opacity: 0; pointer-events: none;
      transition: opacity .2s; box-shadow: 0 8px 24px rgba(0,0,0,.45);
    }
    .toast.show { opacity: 1; }
  `;

  function buildUI() {
    if (ui) return ui;

    const host = document.createElement("div");
    host.id = "naiwa-helper-host";
    host.style.cssText = "position:fixed;z-index:2147483647;top:14px;right:14px;";
    const root = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = CSS;

    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="hd">
        <b>奶蛙辅助</b>
        <button class="fold" title="折叠">–</button>
      </div>
      <div class="bd">
        <div class="sec">跑局内</div>
        <div class="row"><span>永久无敌</span><i class="sw" data-sw="invincible"></i></div>
        <div class="row"><span>金币磁铁</span><i class="sw" data-sw="magnet"></i></div>
        <div class="row"><span>满护盾 (3 层)</span><i class="sw" data-sw="shield"></i></div>

        <div class="sec">金币 / 存档</div>
        <button class="btn ok"  data-act="bank">本局 +100,000 金币并结算</button>
        <button class="btn"     data-act="max">金币拉满 + 解锁全部服装</button>
        <button class="btn warn" data-act="reset">清空本机存档</button>

        <div class="ft">Alt + X 显示 / 隐藏 · 普通模式会上报云端榜单，刷钱请用简单 / 困难</div>
      </div>
    `;

    const toastEl = document.createElement("div");
    toastEl.className = "toast";

    root.append(style, card, toastEl);
    (document.body || document.documentElement).appendChild(host);

    ui = { host, root, card, toastEl, switches: {} };

    // 开关
    root.querySelectorAll(".sw").forEach((el) => {
      const key = el.dataset.sw;
      ui.switches[key] = el;
      el.addEventListener("click", () => {
        const next = !el.classList.contains("on");
        el.classList.toggle("on", next);
        if (key === "invincible") setInvincible(next);
        if (key === "magnet") setMagnet(next);
        if (key === "shield") setShield(next);
      });
    });

    // 按钮
    root.querySelector('[data-act="bank"]').addEventListener("click", () => bankCoins(100000));
    root.querySelector('[data-act="max"]').addEventListener("click", maxOutSave);
    root.querySelector('[data-act="reset"]').addEventListener("click", resetSave);

    // 折叠
    const bd = root.querySelector(".bd");
    const fold = root.querySelector(".fold");
    fold.addEventListener("click", () => {
      const hidden = bd.classList.toggle("collapsed");
      fold.textContent = hidden ? "+" : "–";
    });

    // 不要让面板上的按键传给游戏
    root.addEventListener("keydown", (e) => e.stopPropagation(), true);

    // 事件用捕获阶段拦一下，避免落到游戏的控制监听上
    root.addEventListener("pointerdown", (e) => e.stopPropagation(), true);

    syncUI();
    return ui;
  }

  function syncUI() {
    if (!ui) return;
    ui.switches.invincible.classList.toggle("on", STATE.invincible);
    ui.switches.magnet.classList.toggle("on", STATE.magnet);
    ui.switches.shield.classList.toggle("on", STATE.shield);
  }

  let toastTimer = 0;
  function toast(text) {
    if (!ui) return;
    ui.toastEl.textContent = text;
    ui.toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toastEl.classList.remove("show"), 2600);
  }

  function togglePanel() {
    STATE.panel = !STATE.panel;
    if (STATE.panel) buildUI();
    if (ui) ui.host.style.display = STATE.panel ? "" : "none";
  }

  /* ══════════════════════════ 启动 ══════════════════════════ */

  document.addEventListener(
    "keydown",
    (e) => {
      // Alt+X 切换面板；游戏本身只占用 方向键 / 空格 / P / Esc
      if (e.altKey && (e.key === "x" || e.key === "X")) {
        e.preventDefault();
        togglePanel();
      }
    },
    true
  );

  function boot() {
    let waited = 0;
    const timer = setInterval(() => {
      waited += POLL_MS;
      const RC = window.RunnerCore;

      if (RC && RC.Game && window.gameDebug) {
        clearInterval(timer);
        patch(RC.Game);
        apply();
        setInterval(apply, 500); // 保持开关切换即时生效
        console.log(
          "%c[奶蛙辅助] 补丁已注入（无敌 / 磁铁 / 护盾）",
          "color:#0a0;font-weight:bold"
        );
        if (STATE.panel) buildUI();
        return;
      }

      if (waited >= READY_TIMEOUT) {
        clearInterval(timer);
        console.warn("[奶蛙辅助] 等待 RunnerCore / gameDebug 超时，游戏可能未加载成功");
        if (STATE.panel) buildUI();
      }
    }, POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
