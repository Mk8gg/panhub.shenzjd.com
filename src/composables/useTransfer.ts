/**
 * 「获取」交互（转存链路的前端一半，与官方站同一套协议）
 *
 * 前端只持有一个轻量状态：key → idle | loading | done | dead。
 * 真正的转存编排全在服务端 POST /api/transfer（鉴权/限频/缓存/回退），
 * 前端不做任何链接解析——没有 tid 的链接不出现「获取」按钮。
 *
 * 为什么第三方站点也必须走这个接口：
 * 服务端对已接入转存的盘型会剥离真实直链、只下发 tid，
 * 因此只有调 /api/transfer 才能换回可用的分享链接。
 *
 * 响应分支（服务端 2026-09 起的完整协议，缺一不可）：
 * - code 1 + dead            → 确定性失效，禁用该条目
 * - code 0 + insufficient    → 积分不足，就地弹小程序码看广告赚分后自动重试
 * - code 0 + limited         → 当日该盘型获取达上限
 * - code 0 + fallback        → 未拿到新链接，中性原因 + 原链接仍可复制
 * - code 0 + share_url       → 成功（可能带 points 扣分回执）
 * - 无 tid                   → 把 url 交给后端，由服务端交付原链接并同样计费
 */
import { computed, ref } from "vue";
import { ApiError, apiGet, apiPost } from "../api/client";
import { appNameOf, buildShareText } from "../utils/shareText";
import { applyPointsBalance, refreshPointsBalance } from "./usePoints";

export type TransferStatus = "idle" | "loading" | "done" | "dead";

/** 模块级单例：跨 ResultGroup 实例共享状态与弹窗 */
const statusMap = ref<Record<string, TransferStatus>>({});
/** key → 已生成的口令文本（done 后再点不再请求后端） */
const shareTextCache = ref<Record<string, string>>({});
/** key → 失效原因（dead 后再点直接展示） */
const deadMsgCache = ref<Record<string, string>>({});
/** 底部 toast（限流/忙等轻提示） */
const toast = ref("");
let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** 全局在跑的「获取」动作数：>0 时禁止再发起新的获取 */
const busyCount = ref(0);
const anyBusy = computed(() => busyCount.value > 0);

// —— 内置等待/复制弹窗（components/TransferStatusDialog.vue）——
// 交互：点击「获取」即弹「正在获取」；成功后不自动复制，弹窗内出现「复制」按钮；
// 用户点复制才写入剪贴板，弹窗保持打开（二维码还在，可扫码看广告赚积分），手动关闭。
type TransferDialogStatus =
  | "loading"
  | "ready"
  | "copied"
  | "dead"
  | "fallback"
  | "limited"
  | "insufficient"
  | "error";

const dialogOpen = ref(false);
const dialogMode = ref<"transfer" | "support">("transfer");
const dialogStatus = ref<TransferDialogStatus>("loading");
const dialogMsg = ref("");
const dialogKey = ref("");
/** 扣分回执（仅本次真的扣了分才有）：成功态里展示「已扣 1 积分，余额 9」 */
const dialogPointsTip = ref("");

// —— 看广告赚分 ——
// 「积分不够」时就地弹一张按当前用户签发的小程序码：用户扫码进小程序看激励视频，
// wx-auth 给账号加积分；前端轮询到「已核销」后自动重试本次获取（此时余额已够扣），
// 全程用户不用离开当前页面、也不用再点一次按钮。
const adQrDataUrl = ref("");
const adQrState = ref<"idle" | "loading" | "ready" | "error" | "redeemed" | "expired">(
  "idle"
);
const adQrMsg = ref("");
/** 轮询代际：关弹窗/换动作/重试时自增，旧轮询立即作废（防串台） */
let adPollGen = 0;
let adPollTimer: ReturnType<typeof setTimeout> | null = null;
let adPollTicket = "";
let adPollRetry: (() => void) | null = null;

/** 停止轮询并作废当前代际（关弹窗/开始新动作/拿到结果都要调） */
function stopAdPolling(): void {
  adPollGen++;
  if (adPollTimer) {
    clearTimeout(adPollTimer);
    adPollTimer = null;
  }
  adPollTicket = "";
  adPollRetry = null;
}

/** 打开弹窗：ready=false → 「正在获取」；ready=true → 直接「复制」态 */
function openTransferDialog(key: string, ready = false): void {
  dialogMode.value = "transfer";
  dialogKey.value = key;
  dialogStatus.value = ready ? "ready" : "loading";
  dialogMsg.value = "";
  dialogOpen.value = true;
}

/** 纯提醒模式（无获取动作）：只展示二维码 */
export function openSupportDialog(): void {
  dialogMode.value = "support";
  dialogOpen.value = true;
}

function closeTransferDialog(): void {
  dialogOpen.value = false;
  // 用户主动关掉 = 放弃这次看广告，轮询与自动重试一并作废
  stopAdPolling();
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 兜底：非安全上下文 / 权限被拒时用 execCommand
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
}

/** 弹窗内「复制」按钮：真正写剪贴板，状态就地转「已复制」，弹窗不自动关 */
async function copyFromDialog(): Promise<boolean> {
  const text = shareTextCache.value[dialogKey.value];
  if (!text) return false;
  const copied = await copyText(text);
  const app = appNameOf(text);
  dialogStatus.value = "copied";
  dialogMsg.value = copied ? `已复制，请打开${app}APP粘贴保存` : "复制失败，请重试一次";
  return copied;
}

/** 弹窗内失败态：展示原因，弹窗仍由用户手动关闭 */
function failTransferDialog(msg: string, status: TransferDialogStatus = "error"): void {
  dialogStatus.value = status;
  dialogMsg.value = msg;
  // 失败态一律清掉上一轮的计费回执（积分不足态随后会重设成「当前积分 · 本次需要」）
  dialogPointsTip.value = "";
}

/** 弹窗视图层绑定：components/TransferStatusDialog.vue 使用 */
export function useTransferDialog() {
  return {
    dialogOpen,
    dialogMode,
    dialogStatus,
    dialogMsg,
    dialogPointsTip,
    adQrDataUrl,
    adQrState,
    adQrMsg,
    closeTransferDialog,
    copyFromDialog,
  };
}

export function useTransfer() {
  function showToast(msg: string) {
    toast.value = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.value = "";
    }, 4000);
  }

  function statusOf(key?: string): TransferStatus {
    return (key && statusMap.value[key]) || "idle";
  }

  /**
   * 点击「获取」——所有条目统一入口：前端不区分哪些盘型接了转存。
   * 有 tid → 真实转存（后端按链接分派）；没有 tid → 传 url，后端交付原链接并计费。
   * 两者都**必须**经过 /api/transfer：前端没有任何「本地直接给链接」的快捷路径。
   */
  async function requestTransfer(item: {
    tid?: string;
    url: string;
    name?: string;
  }): Promise<void> {
    const key = item.tid || item.url;
    if (!key) return;
    dialogPointsTip.value = "";
    const current = statusOf(key);

    if (current === "done" && shareTextCache.value[key]) {
      openTransferDialog(key, true);
      return;
    }
    if (current === "dead") {
      showToast(deadMsgCache.value[key] || "该资源已失效，无法获取");
      return;
    }
    if (current === "loading") return;
    // 全局单点：同一时刻页面只允许一个「获取」在跑
    if (busyCount.value > 0) {
      showToast("正在获取其他资源，请稍候");
      return;
    }

    busyCount.value++;
    statusMap.value[key] = "loading";
    openTransferDialog(key);
    const finish = () => {
      busyCount.value = Math.max(0, busyCount.value - 1);
    };

    try {
      // 一律走后端换链接（2026-09-16 口径）：有 tid → 服务端按注册表换回原链接
      // 再转存；没有 tid（正版合规源 / 旧缓存数据）→ 把 url 一并交给服务端，
      // 由它交付原链接并**同样计费**。
      // 前端不再有「没有 tid 就在本地转个圈、直接复制原链接」的旁路——那等于
      // 绕开计费与服务端。
      let shareText = item.url;
      // 扣分回执（仅在真的扣了分时后端才下发 points 字段）
      let pointsTip = "";
      try {
        const resp = await apiPost<{ code: number; data: any }>("/transfer", item.tid
          ? { id: item.tid }
          : { url: item.url, name: item.name });

        // ① 确定性失效：链接不可用，弹窗内给原因
        if (resp.code === 1 && resp.data?.dead) {
          const msg =
            typeof resp.data.message === "string" && resp.data.message
              ? resp.data.message
              : "该资源暂无法获取";
          deadMsgCache.value[key] = msg;
          statusMap.value[key] = "dead";
          failTransferDialog(msg, "dead");
          return;
        }

        // ② 积分不足：就地弹小程序码，看完广告自动重试本次获取。
        //    必须放在 limited 之前——积分不足的响应同时带 limited:true（旧端兼容）。
        if (resp.code === 0 && resp.data?.insufficient) {
          const p = resp.data.points || {};
          const reward = Number(p.adReward) || 10;
          const msg =
            typeof resp.data.message === "string" && resp.data.message
              ? resp.data.message
              : `积分不够了，扫码看个广告（+${reward} 积分）就能继续获取。`;
          statusMap.value[key] = "idle";
          failTransferDialog(msg, "insufficient");
          // 服务端刚读过余额：回写单例，免得弹窗说「当前积分 0」而入口条还显示 1
          applyPointsBalance(p.balance);
          dialogPointsTip.value = `当前积分 ${Number(p.balance) || 0} · 本次需要 ${
            Number(p.amount) || 1
          } 积分`;
          void startAdUnlock(() => void requestTransfer(item));
          return;
        }

        // ③ 每日限流（按盘型）：当天只停该盘型，提示换网盘或明天再来。
        //    不缓存失败提示（次日重试就有意义，与 dead 不同）
        if (resp.code === 0 && resp.data?.limited) {
          const msg =
            typeof resp.data.message === "string" && resp.data.message
              ? resp.data.message
              : "你今天获取这个网盘的次数已经很多了，换个网盘试试或者明天再来吧。";
          statusMap.value[key] = "idle";
          failTransferDialog(msg, "limited");
          return;
        }

        // ④ 未获取到新链接（风控/容量等）：中性原因 + 保留原链接复制入口；
        //    状态回 idle，稍后可重试
        if (resp.code === 0 && resp.data?.fallback) {
          const msg =
            typeof resp.data.message === "string" && resp.data.message
              ? resp.data.message
              : "未能获取到新链接，已为你准备原始链接";
          const origin = resp.data.share_url || item.url;
          if (origin) shareTextCache.value[key] = origin;
          statusMap.value[key] = "idle";
          failTransferDialog(msg, origin ? "fallback" : "error");
          return;
        }

        // ⑤ 成功：拼官方口令 + 计费回执
        if (resp.code === 0 && resp.data?.share_url) {
          shareText = buildShareText(resp.data);
          const pt = resp.data.points;
          if (pt) {
            // 幂等重放时上游给的可能是重放那一刻的快照，不拿它覆盖更新的值
            if (pt.charged !== "replayed") applyPointsBalance(pt.balance);
            pointsTip =
              pt.charged === "unlock"
                ? "已使用 1 次看广告获得的放行额度"
                : pt.charged === "replayed"
                  ? "本次未重复扣分"
                  : `已扣 ${Number(pt.amount) || 0} 积分 · 余额 ${Number(pt.balance) || 0}`;
          }
        }
      } catch (e) {
        // HTTP 错误（配额/tid 过期等）：后端响应里带原链接则兜底
        if (e instanceof ApiError && e.data?.url) shareText = e.data.url;
      }

      // 兜底也没拿到链接（tid 过期/未登录，且直链已被剥离）：不能假装获取成功
      if (!shareText) {
        statusMap.value[key] = "idle";
        failTransferDialog("内容已过期，请重新搜索后再获取");
        return;
      }
      shareTextCache.value[key] = shareText;
      statusMap.value[key] = "done";
      dialogPointsTip.value = pointsTip;
      openTransferDialog(key, true);
    } finally {
      finish();
    }
  }

  /**
   * 开始「看广告赚分」：出码 → 轮询 → 自动重试。
   *
   * 出码走后端 /api/points/ad-qr（服务端用**用户自己的**凭证向 wx-auth 领票），
   * 前端只负责展示与轮询。轮询代际 adPollGen：关弹窗 / 换动作 / 重试时作废旧轮询，
   * 避免旧票的状态回来把新弹窗的状态改掉。
   */
  async function startAdUnlock(retry: () => void): Promise<void> {
    stopAdPolling();
    const gen = adPollGen;
    adQrDataUrl.value = "";
    adQrMsg.value = "";
    adQrState.value = "loading";
    adPollRetry = retry;

    let qr: any = null;
    try {
      qr = await apiPost<any>("/points/ad-qr");
    } catch (e: any) {
      // 端点自身用 200 + ok:false 表达业务失败，走到这里说明是网络/网关错误
      qr = e?.data || null;
    }
    if (gen !== adPollGen) return; // 期间用户已关弹窗或开始新动作

    if (!qr?.ok || !qr.qrDataUrl) {
      adQrState.value = "error";
      adQrMsg.value =
        (typeof qr?.message === "string" && qr.message) ||
        "小程序码生成失败，请稍后再试";
      return;
    }

    adQrDataUrl.value = String(qr.qrDataUrl);
    adQrState.value = "ready";
    adPollTicket = String(qr.ticket || "");
    const expiresMs = Math.max(30, Number(qr.expiresIn) || 900) * 1000;
    scheduleAdPoll(gen, Date.now() + expiresMs);
  }

  /** 2s 一次轮询票状态（票 15 分钟有效，过期即停并提示重新点获取） */
  function scheduleAdPoll(gen: number, deadline: number): void {
    adPollTimer = setTimeout(() => void pollAdTicket(gen, deadline), 2000);
  }

  async function pollAdTicket(gen: number, deadline: number): Promise<void> {
    if (gen !== adPollGen) return;
    if (Date.now() > deadline) {
      adQrState.value = "expired";
      return;
    }

    let r: any = null;
    try {
      r = await apiFetchAdStatus(adPollTicket);
    } catch {
      r = null; // 查询失败按「还没看完」继续轮询，绝不把抖动当过期
    }
    if (gen !== adPollGen) return;

    if (r?.status === "redeemed") {
      adQrState.value = "redeemed";
      // 广告核销 = 余额刚变（+N 分）：强刷一次，让入口条立刻显示新积分
      void refreshPointsBalance(true);
      const retry = adPollRetry;
      stopAdPolling();
      // 积分已到账 → 自动重试本次获取（余额已够扣），用户不用再点一次
      retry?.();
      return;
    }
    if (r?.status === "expired") {
      adQrState.value = "expired";
      return;
    }
    scheduleAdPoll(gen, deadline);
  }

  return {
    statusMap,
    toast,
    statusOf,
    requestTransfer,
    anyBusy,
    startAdUnlock,
  };
}

/**
 * 票状态查询：票是不可枚举的随机串，服务端本就不鉴权；
 * 这里仍走统一封装（带了 Bearer 也无害），省一套请求代码。
 */
function apiFetchAdStatus(ticket: string): Promise<any> {
  return apiGet<any>("/points/ad-status", { ticket });
}
