<!--
  ColormapSelector.vue

  Dropdown for picking a colormap, with a live gradient swatch per option.
  Emits both the selected name and a ready-to-use chroma.js scale.

  Deps:
    npm i chroma-js d3-scale-chromatic dicopal

  Usage:
    <ColormapSelector
      v-model="mapName"
      :domain="[minValue, maxValue]"
      @update:scale="scale => myScale = scale"
    />
-->
<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { GROUPS, colorStops, buildScale } from '../lib/colorscales.js'

const props = defineProps({
  modelValue: { type: String, default: 'viridis' },
  domain: { type: Array, default: () => [0, 1] },
})
const emit = defineEmits(['update:modelValue', 'update:scale'])

const isOpen = ref(false)
const rootEl = ref(null)

const gradients = computed(() => {
  const out = {}
  for (const names of Object.values(GROUPS)) {
    for (const name of names) {
      const stops = colorStops(name, 16)
      out[name] = `linear-gradient(to right, ${stops.join(',')})`
    }
  }
  return out
})

function selectMap(name) {
  emit('update:modelValue', name)
  isOpen.value = false
}

watch(
  () => [props.modelValue, props.domain],
  () => emit('update:scale', buildScale(props.modelValue, props.domain)),
  { immediate: true },
)

function handleClickOutside(e) {
  if (rootEl.value && !rootEl.value.contains(e.target)) isOpen.value = false
}
onMounted(() => document.addEventListener('click', handleClickOutside))
onBeforeUnmount(() => document.removeEventListener('click', handleClickOutside))
</script>

<template>
  <div ref="rootEl" class="colormap-select">
    <button type="button" class="trigger" @click="isOpen = !isOpen">
      <span class="swatch" :style="{ background: gradients[modelValue] }"></span>
      <span class="label">{{ modelValue }}</span>
      <span class="caret">▾</span>
    </button>

    <div v-if="isOpen" class="menu">
      <div v-for="(names, group) in GROUPS" :key="group" class="group">
        <div class="group-label">{{ group }}</div>
        <button
          v-for="name in names"
          :key="name"
          type="button"
          class="option"
          :class="{ active: name === modelValue }"
          @click="selectMap(name)"
        >
          <span class="swatch" :style="{ background: gradients[name] }"></span>
          <span class="label">{{ name }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.colormap-select {
  position: relative;
  width: 220px;
  font-size: 14px;
  color: var(--text-h, #08060d);
}
.trigger {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 6px 10px; border: 1px solid var(--border, #ccc); border-radius: 6px;
  background: var(--bg, #fff); color: inherit; cursor: pointer;
}
.swatch { width: 48px; height: 16px; border-radius: 3px; flex-shrink: 0; }
.label { flex: 1; text-align: left; color: inherit; }
.caret { color: var(--text, #888); }
.menu {
  position: absolute; top: 100%; left: 0; right: 0; margin-top: 4px;
  background: var(--bg, #fff); border: 1px solid var(--border, #ccc); border-radius: 6px;
  color: inherit;
  box-shadow: var(--shadow, 0 4px 12px rgba(0,0,0,0.1)); max-height: 320px; overflow-y: auto;
  z-index: 20; padding: 4px 0;
}
.group-label { padding: 6px 10px 2px; font-size: 11px; color: var(--text, #888); text-transform: uppercase; }
.option {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 6px 10px; border: none; background: none; color: inherit; cursor: pointer;
}
.option:hover { background: var(--code-bg, #f2f2f2); }
.option.active { background: var(--accent-bg, #eef2ff); }
</style>
