<script setup>
defineProps({ error: Error });
function reload() {
  window.location.reload();
}
</script>

<template>
  <section class="panel flex flex-wrap items-center gap-3 p-4 text-sm text-muted">
    <template v-if="error">
      <p role="alert">页面资源加载失败。</p>
      <button class="btn btn-outline" type="button" @click="reload">重新加载</button>
    </template>
    <p v-else role="status">正在加载页面…</p>
  </section>
</template>
