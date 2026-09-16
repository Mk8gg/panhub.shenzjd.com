<template>
  <div v-if="!loading && searches.length === 0" class="hidden"></div>

  <div v-else class="hot-search-section">
    <div class="cloud-container">
      <div v-if="loading" class="loading-state">
        <div class="spinner"></div>
        <span>搜索热度加载中…</span>
      </div>

      <div
        v-show="!loading && searches.length > 0"
        ref="tagCloudRef"
        class="tag-cloud-wrap"
        @click="onContainerClick"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { API_BASE } from "../config";

interface Props {
  onSearch: (term: string) => void;
}

interface HotSearchItem {
  term: string;
  score: number;
  lastSearched: number;
  createdAt: number;
}

const props = defineProps<Props>();

const loading = ref(false);
const searches = ref<HotSearchItem[]>([]);
const hasInitialized = ref(false);
const tagCloudRef = ref<HTMLElement | null>(null);
const isUpdating = ref(false);
let tagCloudInstance: { update: (t: string[]) => void; destroy: () => void } | null = null;
let updateTimer: ReturnType<typeof setTimeout> | null = null;

async function fetchHotSearches() {
  loading.value = true;
  try {
    const response = await fetch(`${API_BASE}/hot-searches?limit=25`);
    const data = await response.json();
    if (data.code === 0 && data.data?.hotSearches) {
      // 服务端已按衰减后的 displayScore 排序，直接使用，不要按原始 score 重排（会导致顺序错位）
      searches.value = data.data.hotSearches.slice(0, 25);
    } else {
      searches.value = [];
    }
  } catch {
    searches.value = [];
  } finally {
    loading.value = false;
  }
}

async function init(preloaded?: HotSearchItem[]) {
  if (hasInitialized.value) return;
  hasInitialized.value = true;
  // 支持外部灌数据——外层统一拉一次 limit=25，前 5 个给热搜词 chips、
  // 整份喂给词云，省掉本组件自己那次请求
  if (preloaded && preloaded.length > 0) {
    searches.value = preloaded.slice(0, 25);
    return;
  }
  await fetchHotSearches();
}

/** 外部注入热搜数据（配合外层统一拉取） */
function setData(items: HotSearchItem[]) {
  searches.value = items.slice(0, 25);
}

function getTerms(): string[] {
  return searches.value.map((s) => s.term);
}

async function initTagCloud() {
  if (!tagCloudRef.value || typeof window === "undefined") return;
  const terms = getTerms();
  if (terms.length === 0) return;

  // 防抖：避免频繁更新
  if (isUpdating.value) {
    if (updateTimer) clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
      isUpdating.value = false;
      initTagCloud();
    }, 300);
    return;
  }

  if (tagCloudInstance) {
    isUpdating.value = true;
    tagCloudInstance.update(terms);
    setTimeout(() => {
      isUpdating.value = false;
    }, 100);
    return;
  }

  const mod: any = await import("TagCloud");
  const TagCloud = mod.default || mod;
  tagCloudInstance = TagCloud(tagCloudRef.value, terms, {
    radius: 150,
    maxSpeed: "slow",
    initSpeed: "slow",
    direction: 135,
    keep: true,
    containerClass: "hot-tagcloud",
    itemClass: "hot-tagcloud-item",
  });
}

function destroyTagCloud() {
  if (updateTimer) {
    clearTimeout(updateTimer);
    updateTimer = null;
  }
  if (tagCloudInstance) {
    tagCloudInstance.destroy();
    tagCloudInstance = null;
  }
  isUpdating.value = false;
}

function onContainerClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (target?.classList?.contains("hot-tagcloud-item")) {
    const term = target.innerText?.trim();
    if (term) props.onSearch(term);
  }
}

watch(
  () => [searches.value.length, loading.value] as const,
  async ([len, ld]) => {
    if (!ld && len > 0) {
      await nextTick();
      initTagCloud();
    }
  },
  { flush: "post" }
);

onBeforeUnmount(() => {
  destroyTagCloud();
});

// 热搜词云仅在页面挂载时拉取一次（随机展示无时效性语义，无需手动刷新）
defineExpose({ init, setData });
</script>

<style scoped>
.hot-search-section {
  width: 100%;
}

.cloud-container {
  width: 100%;
}

.tag-cloud-wrap {
  min-height: 340px;
  padding: 20px;
  background: var(--bg-primary);
  border: 1px solid var(--border-light);
  border-radius: 14px;
  cursor: pointer;
}

/* 覆盖 TagCloud 默认样式，适配项目主题 */
.tag-cloud-wrap :deep(.hot-tagcloud) {
  position: relative;
  width: 100%;
  height: 300px;
  /* GPU 加速 */
  transform: translateZ(0);
  will-change: transform;
}

.tag-cloud-wrap :deep(.hot-tagcloud-item) {
  color: var(--primary-dark, #0f766e) !important;
  font-weight: 600 !important;
  font-family: inherit !important;
  cursor: pointer;
  transition: opacity 0.15s ease;
  /* GPU 加速 */
  transform: translateZ(0);
  will-change: transform, opacity;
}

.tag-cloud-wrap :deep(.hot-tagcloud-item:hover) {
  opacity: 0.9;
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px 20px;
  color: var(--text-secondary);
  background: var(--bg-primary);
  border: 1px solid var(--border-light);
  border-radius: 14px;
}

.spinner {
  width: 28px;
  height: 28px;
  border: 3px solid rgba(15, 118, 110, 0.2);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 640px) {
  .tag-cloud-wrap {
    min-height: 260px;
    padding: 12px;
  }

  .tag-cloud-wrap :deep(.hot-tagcloud) {
    height: 240px;
  }

  .loading-state {
    padding: 24px 12px;
  }
}

.hidden {
  display: none;
}
</style>
