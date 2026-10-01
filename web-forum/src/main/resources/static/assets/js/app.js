/* ==========================================================================
   DevCircle 交互脚本
   --------------------------------------------------------------------------
   包含：点赞乐观更新、图片九宫格布局、加载更多、字符计数、
         WebSocket 客户端封装、多标签页 BroadcastChannel
   说明：原型阶段用 mock 数据与假延迟模拟异步，接入后端时替换 fetch 即可
   ========================================================================== */

(function () {
  'use strict';

  /* ======================================================================
     1. 工具函数
     ====================================================================== */
  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

  /**
   * 数字格式化：1234 -> 1.2k
   */
  function formatCount(n) {
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return (n / 10000).toFixed(1).replace(/\.0$/, '') + 'w';
  }

  /**
   * 相对时间
   */
  function timeAgo(date) {
    const diff = (Date.now() - new Date(date).getTime()) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
    if (diff < 604800) return Math.floor(diff / 86400) + '天前';
    const d = new Date(date);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  /**
   * 假异步：模拟网络延迟
   */
  function mockRequest(ms, shouldFail) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        shouldFail ? reject(new Error('请求失败')) : resolve({ code: 200 });
      }, ms);
    });
  }

  /* ======================================================================
     2. 图片九宫格布局
     ------------------------------------------------------------------
     根据图片数量设置 grid 类名：
       1 张    -> 单列大图
       2、4 张 -> 两列
       其他    -> 三列
     ====================================================================== */
  function applyImageGrid() {
    $$('.post__images').forEach(grid => {
      const count = grid.children.length;
      // 移除旧的修饰类
      grid.className = grid.className.replace(/post__images--\d+/g, '').trim();
      grid.classList.add('post__images--' + count);

      // 超过 9 张时给第 9 张加遮罩
      if (count > 9) {
        const ninth = grid.children[8];
        if (ninth && !$('.post__image-more', ninth)) {
          const more = document.createElement('div');
          more.className = 'post__image-more';
          more.textContent = '+' + (count - 9);
          ninth.appendChild(more);
        }
      }
    });
  }

  /* ======================================================================
     3. 点赞：乐观更新
     ------------------------------------------------------------------
     设计文档约定：后端走 Redis 异步落库，响应极快。
     前端策略：点击立即变更 UI，请求失败则回滚。
     ====================================================================== */
  function initLike() {
    document.addEventListener('click', async function (e) {
      const btn = e.target.closest('.action--like');
      if (!btn) return;

      e.preventDefault();

      const countEl = $('.action__count', btn);

      // ---- 乐观更新：立即变更 UI ----
      // 注意：这里不做「请求中直接 return」的防连点。
      // 用户快速连点（手感抖动、误触）时，若直接丢弃点击，会出现「点了没反应」的
      // 交互缺陷（实测 6 次 60ms 间隔点击只有 2 次生效）。
      // 正确做法：每次点击都立即翻转 UI，并记录「用户期望的最终状态」；
      // 在途请求结束后用最后一次点击的状态做一次对账（reconcile）。
      const wasActive = btn.classList.contains('action--active');
      const prevCount = parseInt(btn.dataset.count || countEl.textContent, 10) || 0;

      const nextActive = !wasActive;
      const nextCount = nextActive ? prevCount + 1 : Math.max(0, prevCount - 1);

      btn.classList.toggle('action--active', nextActive);
      btn.dataset.count = nextCount;
      countEl.textContent = formatCount(nextCount);
      btn.setAttribute('aria-pressed', String(nextActive));
      btn.setAttribute('aria-label', nextActive ? '取消赞' : '赞');

      // 点赞时的弹跳动画（连点时重新触发）
      if (nextActive) {
        btn.classList.remove('action--pop');
        // 强制 reflow，确保动画可以重新播放
        void btn.offsetWidth;
        btn.classList.add('action--pop');
        clearTimeout(btn._popTimer);
        btn._popTimer = setTimeout(() => btn.classList.remove('action--pop'), 320);

        // 粒子迸发（纯装饰，尊重 reduced-motion）
        burstLike(btn);
      }

      // 记录用户期望的最终状态（每次点击都会覆盖）
      btn.dataset.desired = nextActive ? '1' : '0';

      // 已有在途请求 -> 只更新期望状态，等它结束后统一对账
      if (btn.dataset.pending === '1') return;
      btn.dataset.pending = '1';

      // ---- 模拟请求（接入后端时替换为 fetch）----
      try {
        // 5% 概率模拟失败，用于演示回滚
        await mockRequest(220, Math.random() < 0.05);
        // 成功后：用「期望状态」对账，把 UI 对齐到用户最后一次点击的结果
        reconcileLike(btn, countEl);
      } catch (err) {
        // 失败：回滚到本次请求发起前的状态，并清空期望状态
        btn.classList.toggle('action--active', wasActive);
        btn.dataset.count = prevCount;
        countEl.textContent = formatCount(prevCount);
        btn.setAttribute('aria-pressed', String(wasActive));
        btn.setAttribute('aria-label', wasActive ? '取消赞' : '赞');
        btn.dataset.desired = wasActive ? '1' : '0';
        toast('操作失败，请重试', 'error');
      } finally {
        btn.dataset.pending = '0';
      }
    });
  }

  /**
   * 点赞状态对账
   * 在途请求结束后，把 UI 对齐到「用户期望的最终状态」。
   * 若连点导致期望状态与实际不符，这里再做一次切换，并补一次静默请求。
   */
  async function reconcileLike(btn, countEl) {
    const desired = btn.dataset.desired === '1';
    const current = btn.classList.contains('action--active');
    if (desired === current) return;

    const prevCount = parseInt(btn.dataset.count, 10) || 0;
    const nextCount = desired ? prevCount + 1 : Math.max(0, prevCount - 1);
    btn.classList.toggle('action--active', desired);
    btn.dataset.count = nextCount;
    countEl.textContent = formatCount(nextCount);
    btn.setAttribute('aria-pressed', String(desired));
    btn.setAttribute('aria-label', desired ? '取消赞' : '赞');

    // 静默补一次请求，保证服务端最终一致
    try {
      await mockRequest(220, Math.random() < 0.05);
      reconcileLike(btn, countEl);
    } catch (err) {
      toast('操作失败，请重试', 'error');
    }
  }

  /* ======================================================================
     4. 关注按钮
     ------------------------------------------------------------------
     与文档 REL-01 对应：幂等，重复关注不重复计数
     ====================================================================== */
  function initFollow() {
    document.addEventListener('click', async function (e) {
      const btn = e.target.closest('[data-follow]');
      if (!btn) return;

      e.preventDefault();

      const isFollowing = btn.dataset.follow === '1';
      const next = !isFollowing;

      // 乐观更新（连点同样立即翻转，不丢点击）
      btn.dataset.follow = next ? '1' : '0';
      btn.classList.toggle('btn--following', next);
      btn.classList.toggle('btn--primary', !next);
      btn.textContent = next ? '已关注' : '关注';
      btn.dataset.desired = next ? '1' : '0';

      // 在途请求中：只记录期望状态，由在途请求结束后对账
      if (btn.dataset.pending === '1') return;
      btn.dataset.pending = '1';

      try {
        await mockRequest(180);
        reconcileFollow(btn);
      } catch (err) {
        // 回滚
        btn.dataset.follow = isFollowing ? '1' : '0';
        btn.classList.toggle('btn--following', isFollowing);
        btn.classList.toggle('btn--primary', !isFollowing);
        btn.textContent = isFollowing ? '已关注' : '关注';
        btn.dataset.desired = isFollowing ? '1' : '0';
        toast('操作失败，请重试', 'error');
      } finally {
        btn.dataset.pending = '0';
      }
    });
  }

  /**
   * 关注状态对账：把 UI 对齐到用户期望的最终状态
   */
  async function reconcileFollow(btn) {
    const desired = btn.dataset.desired === '1';
    const current = btn.dataset.follow === '1';
    if (desired === current) return;

    btn.dataset.follow = desired ? '1' : '0';
    btn.classList.toggle('btn--following', desired);
    btn.classList.toggle('btn--primary', !desired);
    btn.textContent = desired ? '已关注' : '关注';

    try {
      await mockRequest(180);
      reconcileFollow(btn);
    } catch (err) {
      toast('操作失败，请重试', 'error');
    }
  }

  /* ======================================================================
     5. 发帖编辑器
     ====================================================================== */
  function initComposer() {
    const input = $('#composer-input');
    if (!input) return;

    const counter = $('#composer-counter');
    const submitBtn = $('#composer-submit');
    const MAX = 500;
    const WARN = 450;

    function update() {
      const len = input.value.length;

      // 自适应高度
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 200) + 'px';

      // 字数与状态
      counter.textContent = `${len} / ${MAX}`;
      counter.classList.toggle('counter--warn', len >= WARN && len <= MAX);
      counter.classList.toggle('counter--danger', len > MAX);

      // 有内容且未超限才可发布
      const valid = input.value.trim().length > 0 && len <= MAX;
      submitBtn.disabled = !valid;
    }

    input.addEventListener('input', update);
    update();

    // 发布
    submitBtn.addEventListener('click', async function () {
      const content = input.value.trim();
      if (!content) return;

      submitBtn.disabled = true;
      const originalText = submitBtn.textContent;
      submitBtn.textContent = '发布中...';

      try {
        await mockRequest(600);
        toast('发布成功', 'success');
        input.value = '';
        update();
        // 关闭展开态（若有）
        const wrap = input.closest('.composer');
        if (wrap) wrap.classList.remove('composer--expanded');
      } catch (err) {
        toast('发布失败，请重试', 'error');
      } finally {
        submitBtn.textContent = originalText;
        update();
      }
    });

    // Ctrl/Cmd + Enter 快捷发布
    input.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!submitBtn.disabled) submitBtn.click();
      }
    });
  }

  /* ======================================================================
     6. 加载更多
     ------------------------------------------------------------------
     设计文档约定：游标分页（cursor），不用 offset
     ====================================================================== */
  function initLoadMore() {
    const btn = $('#load-more');
    if (!btn) return;

    btn.addEventListener('click', async function () {
      const feed = $('#feed');
      if (!feed) return;

      btn.disabled = true;
      const originalText = btn.innerHTML;
      btn.innerHTML = '<svg class="action__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>加载中...';

      // 显示骨架屏
      const skeleton = createSkeleton(2);
      feed.insertAdjacentElement('afterend', skeleton);

      try {
        await mockRequest(700);
        skeleton.remove();

        // 原型阶段：克隆已有帖子作为「新加载」内容
        const posts = $$('.post', feed);
        const template = posts[posts.length - 1];
        if (template) {
          for (let i = 0; i < 2; i++) {
            const clone = template.cloneNode(true);
            // 打乱数据，避免看起来完全一样
            const countEl = $('.action__count', clone);
            if (countEl) {
              const n = Math.floor(Math.random() * 90) + 5;
              countEl.textContent = n;
              const likeBtn = $('.action--like', clone);
              if (likeBtn) likeBtn.dataset.count = n;
            }
            // 重置点赞态
            const like = $('.action--like', clone);
            if (like) {
              like.classList.remove('action--active');
              like.setAttribute('aria-pressed', 'false');
            }
            feed.appendChild(clone);
          }
        }
        applyImageGrid();
      } catch (err) {
        skeleton.remove();
        toast('加载失败，请重试', 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
      }
    });
  }

  /**
   * 创建骨架屏
   */
  function createSkeleton(n) {
    const wrap = document.createElement('div');
    wrap.className = 'skeleton-wrap';
    for (let i = 0; i < n; i++) {
      const el = document.createElement('div');
      el.className = 'skeleton-post';
      el.innerHTML = `
        <div class="skeleton skeleton-avatar"></div>
        <div class="skeleton-lines">
          <div class="skeleton skeleton-line" style="width:30%"></div>
          <div class="skeleton skeleton-line" style="width:85%"></div>
          <div class="skeleton skeleton-line" style="width:60%"></div>
        </div>`;
      wrap.appendChild(el);
    }
    return wrap;
  }

  /* ======================================================================
     7. Toast 提示
     ====================================================================== */
  function toast(message, type) {
    let container = $('#toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.setAttribute('role', 'status');
      container.setAttribute('aria-live', 'polite');
      container.style.cssText = `
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
        z-index: 9999; display: flex; flex-direction: column; gap: 8px;
        align-items: center; pointer-events: none;`;
      document.body.appendChild(container);
    }

    const el = document.createElement('div');
    const icon = type === 'error'
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>';
    const bg = type === 'error' ? '#DC2626' : '#0F172A';

    el.style.cssText = `
      display: inline-flex; align-items: center; gap: 8px;
      padding: 10px 18px; border-radius: 9999px;
      background: ${bg}; color: #fff; font-size: 13px; font-weight: 500;
      box-shadow: 0 8px 24px rgba(15,23,42,.18);
      opacity: 0; transform: translateY(8px);
      transition: opacity .2s, transform .2s;`;
    el.innerHTML = icon + '<span>' + message + '</span>';

    container.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
    });

    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(() => el.remove(), 220);
    }, 2200);
  }

  /* ======================================================================
     8. WebSocket 客户端
     ------------------------------------------------------------------
     按《缓存与实时通信设计》实现：
       - token 放 query 参数（浏览器 WS 不支持自定义 Header）
       - 30 秒心跳 PING
       - 指数退避重连（1s -> 2s -> 4s -> 8s -> 30s 封顶）
       - 多标签页用 BroadcastChannel 共用一条连接
     ====================================================================== */
  const WsClient = {
    socket: null,
    retries: 0,
    maxRetries: 10,
    heartbeatTimer: null,
    pongTimer: null,
    channel: null,
    isLeader: false,

    /**
     * 初始化
     * @param {string} url       WebSocket 地址
     * @param {string} token     JWT
     * @param {Function} onMessage 收到消息的回调
     */
    init(url, token, onMessage) {
      this.url = url;
      this.token = token;
      this.onMessage = onMessage || function () {};

      // 多标签页协调：只有 leader 持有真实连接
      if ('BroadcastChannel' in window) {
        this.channel = new BroadcastChannel('devcircle-ws');

        // 询问是否已有 leader
        this.channel.postMessage({ type: '__WHO_IS_LEADER__' });

        // 3 秒内没收到 leader 响应，则自己当 leader
        this.leaderTimeout = setTimeout(() => {
          this.isLeader = true;
          this.connect();
        }, 300);

        this.channel.onmessage = (e) => {
          const msg = e.data;

          // 已有 leader：本页不建连接，只转发
          if (msg.type === '__I_AM_LEADER__') {
            clearTimeout(this.leaderTimeout);
            this.isLeader = false;
          }
          // 别人在问：我是 leader 就应答
          else if (msg.type === '__WHO_IS_LEADER__' && this.isLeader) {
            this.channel.postMessage({ type: '__I_AM_LEADER__' });
          }
          // leader 广播业务消息：本页消费
          else if (msg.type === '__WS_MESSAGE__') {
            this.handleMessage(msg.payload);
          }
          // 非 leader 请求发送消息
          else if (msg.type === '__WS_SEND__' && this.isLeader) {
            this.rawSend(msg.payload);
          }
        };
      } else {
        this.isLeader = true;
        this.connect();
      }
    },

    connect() {
      if (!this.isLeader) return;

      try {
        this.socket = new WebSocket(this.url + '?token=' + this.token);
      } catch (err) {
        this.scheduleReconnect();
        return;
      }

      this.socket.onopen = () => {
        this.retries = 0;
        this.startHeartbeat();
        console.log('[WS] 已连接');
      };

      this.socket.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch (err) { return; }

        // PONG 用于心跳超时判断
        if (msg.type === 'PONG') {
          clearTimeout(this.pongTimer);
          return;
        }

        // leader 收到消息，广播给所有标签页
        this.handleMessage(msg);
        if (this.channel) {
          this.channel.postMessage({ type: '__WS_MESSAGE__', payload: msg });
        }
      };

      this.socket.onclose = () => {
        this.stopHeartbeat();
        this.scheduleReconnect();
      };

      this.socket.onerror = () => {
        // onclose 会跟进处理重连
      };
    },

    handleMessage(msg) {
      this.onMessage(msg);
    },

    rawSend(payload) {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify(payload));
      }
    },

    /** 发送消息（非 leader 通过 channel 转发） */
    send(payload) {
      if (this.isLeader) {
        this.rawSend(payload);
      } else if (this.channel) {
        this.channel.postMessage({ type: '__WS_SEND__', payload });
      }
    },

    /** 指数退避重连 */
    scheduleReconnect() {
      if (!this.isLeader) return;
      if (this.retries >= this.maxRetries) {
        console.warn('[WS] 重连次数已达上限');
        return;
      }

      // 1s, 2s, 4s, 8s, 16s, 30s(封顶)
      const delay = Math.min(1000 * Math.pow(2, this.retries), 30000);
      this.retries++;

      console.log(`[WS] ${delay / 1000}s 后重连（第 ${this.retries} 次）`);
      setTimeout(() => this.connect(), delay);
    },

    /** 心跳：30 秒 PING，10 秒未收到 PONG 则判定断线 */
    startHeartbeat() {
      this.stopHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        this.rawSend({ type: 'PING', data: null, timestamp: Date.now() });

        // 10 秒内没收到 PONG 则主动断开重连
        this.pongTimer = setTimeout(() => {
          console.warn('[WS] 心跳超时，主动重连');
          if (this.socket) this.socket.close();
        }, 10000);
      }, 30000);
    },

    stopHeartbeat() {
      clearInterval(this.heartbeatTimer);
      clearTimeout(this.pongTimer);
    }
  };

  /* ======================================================================
     9. 消息未读红点更新（收到 WS 推送时调用）
     ====================================================================== */
  function updateUnreadBadge(total) {
    const badge = $('#notify-badge');
    if (!badge) return;

    if (total > 0) {
      badge.textContent = total > 99 ? '99+' : String(total);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  /* ======================================================================
     10. 密码可见性切换 + 强度检测
     ====================================================================== */
  function initPassword() {
    // 可见性切换
    $$('[data-toggle-password]').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = $('#' + btn.dataset.togglePassword);
        if (!input) return;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
      });
    });

    // 强度检测
    const pwd = $('#register-password');
    const strength = $('#password-strength');
    if (!pwd || !strength) return;

    pwd.addEventListener('input', () => {
      const v = pwd.value;
      let score = 0;
      if (v.length >= 8) score++;
      if (/[a-zA-Z]/.test(v) && /\d/.test(v)) score++;
      if (/[^a-zA-Z0-9]/.test(v) || v.length >= 12) score++;

      const bars = $$('.strength__bar', strength);
      const level = ['', 'weak', 'medium', 'strong'][score] || '';

      bars.forEach((bar, i) => {
        bar.className = 'strength__bar';
        if (level && i < score) {
          bar.classList.add('strength__bar--active-' + level);
        }
      });
    });
  }

  /* ======================================================================
     11. 交互反馈动效
     ------------------------------------------------------------------
     V2.2 只保留「有明确反馈意义」的动效：点击涟漪、点赞粒子。
     常驻循环类装饰动效（极光、扫描线、呼吸发光）已全部移除。

     统一约束：
       - 只操作 transform / opacity，不碰 layout 属性
       - 遵循 prefers-reduced-motion，用户关掉动效时直接跳过
       - 装饰元素带 aria-hidden，不进无障碍树
     ====================================================================== */

  /**
   * 是否允许播放装饰动效
   */
  function motionAllowed() {
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /**
   * 主按钮点击涟漪
   * 在点击坐标处插一个圆点，靠 transform: scale 扩散，结束后自动移除
   */
  function initRipple() {
    document.addEventListener('pointerdown', function (e) {
      const btn = e.target.closest('.btn--primary');
      if (!btn) return;

      const rect = btn.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const x = e.clientX - rect.left - size / 2;
      const y = e.clientY - rect.top - size / 2;

      const ripple = document.createElement('span');
      ripple.className = 'fx-ripple';
      ripple.setAttribute('aria-hidden', 'true');
      ripple.style.width = ripple.style.height = size + 'px';
      ripple.style.left = x + 'px';
      ripple.style.top = y + 'px';

      btn.appendChild(ripple);
      ripple.addEventListener('animationend', () => ripple.remove());
    });
  }

  /**
   * 点赞成功的粒子迸发
   * 8 个粒子按圆周均分角度飞出，位移由 CSS 变量 --dx / --dy 驱动
   */
  function burstLike(btn) {
    if (!motionAllowed()) return;

    const burst = document.createElement('span');
    burst.className = 'fx-burst';
    burst.setAttribute('aria-hidden', 'true');

    const COUNT = 8;
    const INNER = 15;   // 起飞半径：贴着图标边缘，不穿过心形与数字
    const OUTER = 38;   // 终点半径

    for (let i = 0; i < COUNT; i++) {
      const angle = (Math.PI * 2 * i) / COUNT - Math.PI / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      const dot = document.createElement('span');
      dot.className = 'fx-burst__dot';
      dot.style.setProperty('--sx', cos * INNER + 'px');
      dot.style.setProperty('--sy', sin * INNER + 'px');
      dot.style.setProperty('--dx', cos * OUTER + 'px');
      dot.style.setProperty('--dy', sin * OUTER + 'px');
      dot.style.animationDelay = (i % 2) * 40 + 'ms';
      burst.appendChild(dot);
    }

    btn.appendChild(burst);

    // 注意：animationend 会冒泡。若监听容器，最先结束的粒子就会把整个容器移除，
    // 把带 animationDelay 的粒子提前截断。因此只监听「最后结束」的那一个。
    const last = burst.lastElementChild;
    if (last) last.addEventListener('animationend', () => burst.remove());
    // 兜底：避免个别浏览器 animationend 不触发导致节点残留
    setTimeout(() => burst.remove(), 1200);
  }

  /* ======================================================================
     12. 自动初始化
     ====================================================================== */
  function init() {
    applyImageGrid();
    initLike();
    initFollow();
    initComposer();
    initLoadMore();
    initPassword();
    initRipple();

    // 页面可见性变化时，重新计算图片网格（应对字体加载导致的宽度变化）
    window.addEventListener('load', applyImageGrid);
    window.addEventListener('resize', debounce(applyImageGrid, 200));
  }

  function debounce(fn, wait) {
    let timer;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, arguments), wait);
    };
  }

  // ---- 暴露到全局 ----
  window.DevCircle = {
    toast,
    formatCount,
    timeAgo,
    WsClient,
    updateUnreadBadge,
    applyImageGrid,
    burstLike,
    motionAllowed
  };

  // ---- 启动 ----
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
