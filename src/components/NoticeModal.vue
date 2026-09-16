<template>
  <!-- 弹窗公告：与顶部公告条相互独立，用于群聊二维码等强提示场景。
       版本号写死在组件内，点「我知道了」后按版本记入 LocalStorage，之后不再提示；
       改文案/换图时升级版本号即可重新展示。
       部署方如需替换文案与二维码，直接传 props 覆盖即可。 -->
  <Teleport to="body">
    <div v-if="visible" class="nm-mask" @click.self="dismiss">
      <div class="nm-modal" role="dialog" aria-modal="true" aria-label="站内公告">
        <button class="nm-close" type="button" aria-label="关闭" title="关闭" @click="dismiss">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>

        <h3 class="nm-title">{{ title }}</h3>

        <p class="nm-text">{{ text }}</p>

        <div v-if="qrSrc && !qrFailed" class="nm-qr">
          <img :src="qrSrc" alt="群聊二维码" loading="lazy" @error="onQrError" />
        </div>
        <p v-if="qrSrc" class="nm-hint">扫码加入群聊</p>

        <button class="nm-btn" type="button" @click="dismiss">我知道了</button>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

// 版本号：每次修改本弹窗内容（文案/图片）时 +1，
// 已点过「我知道了」的老用户会因 key 变化重新看到一次
const NOTICE_VERSION = 1;
const NOTICE_KEY = `panhub:notice-popup-dismissed:v${NOTICE_VERSION}`;

const props = withDefaults(
  defineProps<{
    title?: string;
    /** 公告正文。留空则不弹（部署方不配就不打扰用户） */
    text?: string;
    /** 留空则不展示二维码（纯文字公告） */
    qrSrc?: string;
  }>(),
  {
    title: "公告",
    text: "",
    qrSrc: "",
  }
);

const qrSrc = computed(() => props.qrSrc);

const visible = ref(false);
const qrFailed = ref(false);

onMounted(() => {
  // 未配置任何内容 → 不弹（第三方部署方默认无公告）
  if (!props.text && !props.qrSrc) return;
  try {
    if (localStorage.getItem(NOTICE_KEY)) return;
  } catch {}
  // 稍作延迟，避免首屏打开时立刻被弹窗抢焦点
  setTimeout(() => {
    visible.value = true;
  }, 800);
});

function dismiss() {
  visible.value = false;
  try {
    localStorage.setItem(NOTICE_KEY, "1");
  } catch {}
}

// 图片挂了就把二维码区域藏起来，弹窗文字照常展示
function onQrError() {
  qrFailed.value = true;
}
</script>

<style scoped>
/* 遮罩：全屏居中，点空白也算「我知道了」 */
.nm-mask {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(15, 23, 42, 0.45);
  animation: nm-fade 0.18s ease;
}

.nm-modal {
  position: relative;
  width: 100%;
  max-width: 360px;
  max-height: calc(100vh - 40px);
  overflow-y: auto;
  padding: 28px 24px 24px;
  border-radius: var(--radius-lg, 16px);
  background: var(--bg-primary, #fff);
  border: 1px solid var(--border-light, #e5e7eb);
  box-shadow: var(--shadow-xl, 0 20px 50px rgba(15, 23, 42, 0.2));
  text-align: center;
  animation: nm-pop 0.22s ease;
}

.nm-close {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-tertiary, #9ca3af);
  cursor: pointer;
}
.nm-close:hover {
  background: var(--bg-secondary, #f3f4f6);
  color: var(--text-secondary, #4b5563);
}

.nm-title {
  margin: 0 0 12px;
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary, #111827);
}

.nm-text {
  margin: 0 0 16px;
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-secondary, #4b5563);
  text-align: left;
  white-space: pre-line;
}

.nm-qr {
  display: inline-block;
  padding: 8px;
  border-radius: var(--radius-md, 12px);
  border: 1px solid var(--border-light, #e5e7eb);
  background: var(--bg-secondary, #f9fafb);
}
.nm-qr img {
  display: block;
  width: 200px;
  max-width: 100%;
  border-radius: 6px;
}

.nm-hint {
  margin: 10px 0 18px;
  font-size: 12px;
  color: var(--text-tertiary, #9ca3af);
}

.nm-btn {
  width: 100%;
  padding: 10px 0;
  border: none;
  border-radius: var(--radius-md, 10px);
  background: var(--primary, #0f766e);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s ease;
}
.nm-btn:hover {
  opacity: 0.88;
}

@keyframes nm-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes nm-pop {
  from {
    transform: scale(0.94) translateY(8px);
    opacity: 0;
  }
  to {
    transform: scale(1) translateY(0);
    opacity: 1;
  }
}
</style>
