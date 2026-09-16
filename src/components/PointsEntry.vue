<template>
  <!-- 积分入口：本站的每日签到是「进页自动签」——用户能看到积分（获取弹窗里的
       扣分回执、签到 toast），但页面上没有任何「领积分」的动作可点，
       分不够时只看到「扫码看广告」。这里补一个明确的去处：小程序「我的」页是
       唯一的手动签到入口（那边刻意不做自动签到——签到是它的每日回访钩子），
       所以引导路径是「扫码进小程序 → 我的 → 签到」。
       只在读得到余额时出现（= 已认证且账本可用）：没登录的访客连积分都没有，
       先给入口只是噪音 -->
  <div v-if="ready" class="points-entry">
    <button class="pe-trigger" type="button" @click="visible = true">
      <svg
        class="pe-coin"
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle cx="8" cy="8" r="6"></circle>
        <path d="M18.09 10.37A6 6 0 1 1 10.34 18"></path>
        <path d="M7 6h1v4"></path>
        <path d="m16.71 13.88.7.71-2.82 2.82"></path>
      </svg>
      <span class="pe-balance" :class="{ 'pe-balance--bump': bumping }">积分 <b>{{ balance ?? 0 }}</b></span>
      <span class="pe-sep" aria-hidden="true"></span>
      <span class="pe-cta">小程序签到领积分</span>
      <svg
        class="pe-arrow"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M5 12h14M12 5l7 7-7 7"></path>
      </svg>
    </button>
  </div>

  <Teleport to="body">
    <div v-if="visible" class="pe-mask" @click.self="visible = false">
      <div class="pe-modal" role="dialog" aria-modal="true" aria-label="小程序签到领积分">
        <button class="pe-close" type="button" aria-label="关闭" title="关闭" @click="visible = false">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>

        <h3 class="pe-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="8" cy="8" r="6"></circle>
            <path d="M18.09 10.37A6 6 0 1 1 10.34 18"></path>
            <path d="M7 6h1v4"></path>
            <path d="m16.71 13.88.7.71-2.82 2.82"></path>
          </svg>
          小程序签到领积分
        </h3>
        <p class="pe-sub">
          每次「获取」消耗 1 积分{{ checkinReward > 0 ? `，签到一次得 ${checkinReward} 积分` : "" }}
        </p>

        <div class="pe-qr">
          <img v-if="!qrFailed" :src="qrSrc" alt="PanHub 小程序码" @error="qrFailed = true" />
          <p v-else class="pe-qr-fallback">小程序码没加载出来，可在微信里搜索「PanHub 网盘搜索」</p>
        </div>

        <ol class="pe-steps">
          <li>微信扫一扫上面的小程序码</li>
          <li>点底部「我的」</li>
          <li>点「签到」，每天领一次积分</li>
        </ol>

        <p class="pe-hint">积分不够时也能在小程序里看广告攒积分</p>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { refreshPointsBalance, usePoints } from "../composables/usePoints";

// 小程序码（官方 CDN）。部署方可传 qr-src 覆盖
const props = withDefaults(
  defineProps<{
    qrSrc?: string;
  }>(),
  {
    qrSrc:
      "https://cdn.jsdmirror.com/gh/wu529778790/img.shenzjd.com@master/blog/img.shenzjd.com-20260916-092907-oe86.png",
  }
);

const { balance, checkinReward, ready } = usePoints();

const visible = ref(false);
const qrFailed = ref(false);
/** 余额刚变过：给数字一个短促的放大反馈——「滞后感」有一半来自数值悄悄变了却没动静 */
const bumping = ref(false);
let bumpTimer: ReturnType<typeof setTimeout> | null = null;

watch(balance, (next, prev) => {
  if (prev === null || next === null || next === prev) return;
  bumping.value = true;
  if (bumpTimer) clearTimeout(bumpTimer);
  bumpTimer = setTimeout(() => {
    bumping.value = false;
  }, 700);
});

// 弹窗打开期间锁定页面滚动；打开这一刻顺带校准余额——用户正盯着积分看
watch(visible, (open) => {
  if (typeof document === "undefined") return;
  document.body.style.overflow = open ? "hidden" : "";
  if (open) void refreshPointsBalance();
});

/**
 * 切回前台 / 窗口聚焦时校准：去小程序看完广告再切回浏览器，是余额最可能变过的
 * 时刻，也是用户最关心这个数字的时刻。连续切标签页由 refreshPointsBalance
 * 内部的 15s 节流吸收，不会变成压测。
 */
function onActive() {
  if (typeof document !== "undefined" && document.hidden) return;
  void refreshPointsBalance();
}

// Esc 关闭
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && visible.value) visible.value = false;
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  document.addEventListener("visibilitychange", onActive);
  window.addEventListener("focus", onActive);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  document.removeEventListener("visibilitychange", onActive);
  window.removeEventListener("focus", onActive);
  if (bumpTimer) clearTimeout(bumpTimer);
  if (typeof document !== "undefined") document.body.style.overflow = "";
});
</script>

<style scoped>
/* 入口条：贴在搜索框下方右侧，轻量不抢搜索主视线 */
.points-entry {
  display: flex;
  justify-content: flex-end;
  margin-top: -8px;
}

.pe-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary, #4b5563);
  background: var(--bg-input, rgba(255, 255, 255, 0.5));
  border: 1px solid rgba(15, 118, 110, 0.2);
  border-radius: 999px;
  cursor: pointer;
  transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
}

.pe-trigger:hover {
  transform: translateY(-1px);
  border-color: rgba(15, 118, 110, 0.4);
  box-shadow: 0 4px 12px rgba(15, 118, 110, 0.15);
}

.pe-coin {
  flex-shrink: 0;
  color: var(--secondary, #f59e0b);
}

.pe-balance {
  color: var(--text-secondary, #4b5563);
  font-variant-numeric: tabular-nums;
}
.pe-balance b {
  display: inline-block; /* 缩放反馈需要它成为可变换的块 */
  color: var(--primary, #0f766e);
  font-size: 15px;
  font-weight: 800;
}

/* 余额变化反馈：短促放大 + 变色，用户能看出这个数字刚更新过 */
.pe-balance--bump b {
  animation: pe-bump 0.7s ease;
}
@keyframes pe-bump {
  0% {
    transform: scale(1);
  }
  30% {
    transform: scale(1.3);
    color: var(--secondary, #f59e0b);
  }
  100% {
    transform: scale(1);
  }
}

.pe-sep {
  width: 1px;
  height: 12px;
  background: var(--border-light, rgba(148, 163, 184, 0.35));
}

.pe-cta {
  color: var(--primary, #0f766e);
  font-weight: 600;
}

.pe-arrow {
  flex-shrink: 0;
  color: var(--text-tertiary, #9ca3af);
}

/* 弹窗：与 TransferStatusDialog / NoticeModal 同款遮罩与卡片语言 */
.pe-mask {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(15, 23, 42, 0.45);
  animation: pe-fade 0.18s ease;
}

.pe-modal {
  position: relative;
  /* 二维码尺寸：步骤缩进按它反推，保证序号与二维码左边缘对齐 */
  --pe-qr-size: 190px;
  width: 360px;
  max-width: 92vw;
  max-height: 88vh;
  overflow-y: auto;
  padding: 24px 24px 20px;
  border-radius: 16px;
  background: var(--bg-primary, #fffdf8);
  border: 1px solid var(--border-light, rgba(17, 24, 39, 0.08));
  box-shadow: 0 24px 48px rgba(17, 24, 39, 0.18);
  text-align: center;
  animation: pe-rise 0.22s ease;
}

.pe-close {
  position: absolute;
  top: 12px;
  right: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-tertiary, #9ca3af);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.pe-close:hover {
  background: var(--bg-hover, rgba(17, 24, 39, 0.06));
  color: var(--text-primary, #111827);
}
.pe-close svg {
  stroke: currentColor;
}

.pe-title {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  margin: 0 0 8px;
  font-size: 17px;
  font-weight: 700;
  color: var(--text-primary, #111827);
  line-height: 1.3;
}
.pe-title svg {
  flex-shrink: 0;
  color: var(--secondary, #f59e0b);
}

.pe-sub {
  margin: 0 0 14px;
  font-size: 13px;
  color: var(--text-tertiary, #6b7280);
  line-height: 1.5;
}

.pe-qr {
  display: flex;
  justify-content: center;
  margin-bottom: 14px;
}
.pe-qr img {
  width: var(--pe-qr-size);
  height: var(--pe-qr-size);
  border-radius: 10px;
  border: 1px solid var(--border-light, rgba(17, 24, 39, 0.08));
  object-fit: cover;
}
.pe-qr-fallback {
  margin: 0;
  padding: 24px 12px;
  font-size: 13px;
  color: var(--text-secondary, #4b5563);
  line-height: 1.6;
  border: 1px dashed var(--border-light, rgba(17, 24, 39, 0.16));
  border-radius: 10px;
}

/* 签到路径：步骤必须写清「在哪里点」——只给二维码用户会停在首页 */
/* 左侧缩进 = 二维码居中后的左边缘，让序号圆点与二维码左边对齐（窄屏时为 0 不溢出） */
.pe-steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0 0 12px;
  padding: 0 0 0 calc((100% - var(--pe-qr-size)) / 2);
  list-style: none;
  counter-reset: pe-step;
  text-align: left;
}
.pe-steps li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary, #4b5563);
  line-height: 1.5;
}
.pe-steps li::before {
  counter-increment: pe-step;
  content: counter(pe-step);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(15, 118, 110, 0.12);
  color: var(--primary, #0f766e);
  font-size: 11px;
  font-weight: 700;
}

.pe-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-tertiary, #9ca3af);
  line-height: 1.6;
}

@keyframes pe-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes pe-rise {
  from {
    opacity: 0;
    transform: translateY(12px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* 移动端：入口条居中（右侧留白太窄会显得挤），弹窗二维码略缩 */
@media (max-width: 640px) {
  .points-entry {
    justify-content: center;
  }
  .pe-trigger {
    padding: 7px 12px;
    font-size: 12px;
    gap: 6px;
  }
  .pe-balance b {
    font-size: 14px;
  }
  .pe-modal {
    --pe-qr-size: 170px;
  }
}

/* 减少动画模式 */
@media (prefers-reduced-motion: reduce) {
  .pe-mask,
  .pe-modal {
    animation: none;
  }
  .pe-balance--bump b {
    animation: none;
  }
  .pe-trigger:hover {
    transform: none;
  }
}
</style>
