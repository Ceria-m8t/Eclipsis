<script setup lang="ts">
import { RouterView } from 'vue-router'
import { vvDebug } from './viewport'
</script>

<template>
  <RouterView />
  <!-- 视口诊断：设置页里打开，所有页面左上角都会显示 -->
  <div v-if="vvDebug" class="vv-debug" aria-hidden="true">{{ vvDebug }}</div>
</template>

<style>
.vv-debug {
  position: fixed;
  z-index: 9999;
  left: 8px;
  right: 8px;
  top: calc(var(--safe-top) + 2px);
  font: 11px/1.4 var(--mono);
  white-space: pre-wrap;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  padding: 3px 8px;
  border-radius: 8px;
  pointer-events: none;
}
</style>
