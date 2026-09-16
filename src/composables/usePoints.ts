/**
 * 积分（余额 + 每日自动签到，与官方站同一套口径）
 *
 * 产品口径：**不设免费额度**，每次「获取」扣 1 积分；每天的免费次数由签到承担
 * ——每天第一次进站自动签到 +N 分，不够就扫码看激励广告 +M 分。
 *
 * 签到时机（按 wx-auth 接入话术）：**进页调 balance → checkedIn=false 才调 checkin**。
 * 不要盲调签到、也不要自己用本地时间算日期（用户不在 UTC+8 会算错），
 * checkedIn 由服务端按北京自然日算好。
 *
 * 模块级单例（同 useTransfer 的做法）：积分是账号维度信息，页面上会有多处展示
 * （搜索框下的入口条 / 弹窗里的计费回执），必须看到同一份余额；而且「进页读一次
 * 余额 + 未签则签」这件事本身只该发生一次——多组件各持一份 ref 会重复打接口。
 *
 * 全程静默：积分是增强信息，任何一步失败（未登录 401 / 服务不可用 / 网络抖动）
 * 都只是「这次没提示」，绝不能弹出报错打断用户——计费链路的可用性由服务端
 * fail-open 兜底，前端只负责好看。
 *
 * 余额刷新策略（2026-09-16）：**不做定时轮询**，只认「余额真的可能变过」的时刻，
 * 因为入口条上的数字只要在用户「正看着它」时是对的，就不会被感知成滞后。三条路径：
 *   1. 本地回写（零请求，主力）——/transfer 响应里的 points.balance 是账本的权威
 *      读数（扣分回执），applyPointsBalance 直接写进单例，弹窗和入口条永远同源；
 *   2. 关键时刻强刷（refreshPointsBalance(true)）——看广告核销成功后余额刚变，
 *      这一次请求花得最值；点开积分弹窗时用户正盯着数字，也顺带校准一次；
 *   3. 切回前台校准（refreshPointsBalance()，节流 MIN_REFRESH_GAP_MS）——
 *      用户去小程序看完广告切回来，value 必变；节流是为了让连续切标签页不变成压测。
 * 故意不做「每 N 秒轮询」：余额变化的触发源（转存/签到/广告）全在用户自己的操作里，
 * 没有别人替他改余额的场景，轮询只会在用户什么都不做时白打接口。
 */
import { ref } from "vue";
import type { Ref } from "vue";
import { apiGet, apiPost } from "../api/client";
import { useToast } from "./useToast";

export interface UsePointsReturn {
  /** 当前余额（未知为 null） */
  balance: Ref<number | null>;
  /** 今天是否已签到（服务端口径，北京自然日） */
  checkedIn: Ref<boolean>;
  /** 本次会话实发的签到积分（0 = 没发/今天已领过） */
  granted: Ref<number>;
  /** 每日签到发几分（账本参数，0 = 还没取到，文案别写死数字） */
  checkinReward: Ref<number>;
  /** 是否成功读到过余额（未登录/服务不可用时保持 false） */
  ready: Ref<boolean>;
  /** 进页调用一次：读余额 + 未签到则签到（幂等，重复调用安全） */
  ensureDailyCheckin: () => Promise<void>;
  /** 只读余额（不签到）：切回前台/打开积分弹窗时校准，force 跳过节流 */
  refreshBalance: (force?: boolean) => Promise<void>;
}

/** 连续切标签页/连续聚焦时的最小刷新间隔：吸收连击，又不至于让切回前台刷不到 */
const MIN_REFRESH_GAP_MS = 15_000;

/** 当前余额（null = 还不知道：未登录 / 服务不可用） */
const balance = ref<number | null>(null);
/** 今天是否已签到（服务端口径，北京自然日）；本站签到是自动的，仅作展示 */
const checkedIn = ref(false);
/** 本次会话实发的签到积分（0 = 没发/今天已领过） */
const granted = ref(0);
/** 每日签到发几分（账本参数下发，前端文案不写死） */
const checkinReward = ref(0);
/** 是否成功读到过余额（未登录/服务不可用时保持 false，也是入口的显示开关） */
const ready = ref(false);
/** 在途请求：多个组件同时进页只打一轮（签到上游幂等，这里只为省往返） */
let inflight: Promise<void> | null = null;
/** 纯刷新在途（与签到链分开：签到在跑时前台回来仍可校准一次） */
let inflightRefresh: Promise<void> | null = null;
/** 上次「拿到权威余额」的时刻（节流基准；本地回写也计入） */
let lastSyncedAt = 0;

/** 读一次余额并落到单例（不签到）；返回是否读到 */
async function readBalance(): Promise<boolean> {
  let info: any = null;
  try {
    info = await apiGet<any>("/points/balance");
  } catch {
    return false; // 未登录（401）/ 服务不可用：静默
  }
  if (!info?.ok) return false;

  balance.value = Number(info.balance) || 0;
  checkedIn.value = info.checkedIn === true;
  checkinReward.value = Number(info.checkinReward) || 0;
  ready.value = true;
  lastSyncedAt = Date.now();
  return true;
}

/**
 * 只读一次余额（不签到）：切回前台、点开积分弹窗、广告核销后用。
 * force=true 跳过节流——调用方已知余额刚变过，必须立刻看到新值。
 * 全程静默：读不到就维持原值，绝不弹错。
 */
export function refreshPointsBalance(force = false): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (!force && Date.now() - lastSyncedAt < MIN_REFRESH_GAP_MS) {
    return Promise.resolve();
  }
  if (!inflightRefresh) {
    inflightRefresh = readBalance()
      .then(() => undefined)
      .finally(() => {
        inflightRefresh = null;
      });
  }
  return inflightRefresh;
}

/**
 * 本地回写余额：服务端在 /transfer 响应里已下发账本权威读数（扣分回执），
 * 直接写进单例，零额外请求——这是入口条不滞后的主力路径。
 * 非法值（undefined/NaN/负数）一律忽略，宁可不更新也不写脏。
 */
export function applyPointsBalance(value: unknown): void {
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) return;
  balance.value = v;
  ready.value = true;
  lastSyncedAt = Date.now(); // 权威读数：此刻起 15s 内无需再读
}

export function usePoints(): UsePointsReturn {
  const { showToast } = useToast();

  async function run(): Promise<void> {
    const ok = await readBalance();
    if (!ok) return; // 未登录（401）/ 服务不可用：静默

    // 今天已签：什么都不做（不弹提示、不再发请求）——上游幂等，但没必要多打一次
    if (checkedIn.value) return;

    try {
      const r: any = await apiPost<any>("/points/checkin");
      // granted=0 = 并发/双 tab 竞态下已被另一个请求领走，静默即可（不提示）
      if (r?.ok && Number(r.granted) > 0) {
        granted.value = Number(r.granted);
        // balance 只在本次真的发分时可信（幂等重放返回 null）
        if (typeof r.balance === "number") applyPointsBalance(r.balance);
        checkedIn.value = true;
        showToast(`今日签到 +${granted.value} 积分`, "success");
      } else if (r?.ok) {
        checkedIn.value = true;
      }
    } catch {
      // 静默：签到失败不影响任何功能（明天/下次进页会自动重试）
    }
  }

  function ensureDailyCheckin(): Promise<void> {
    if (typeof window === "undefined") return Promise.resolve();
    if (!inflight) {
      inflight = run().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  return {
    balance,
    checkedIn,
    granted,
    checkinReward,
    ready,
    ensureDailyCheckin,
    refreshBalance: refreshPointsBalance,
  };
}
