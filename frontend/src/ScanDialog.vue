<script setup>
import { onUnmounted, ref } from 'vue';
import { LoaderCircle, ScanLine, X } from '@lucide/vue';

const props = defineProps({ api: { type: Function, required: true } });
const emit = defineEmits(['connected']);
const dialog = ref(null);
const qr = ref('');
const message = ref('');
const state = ref('idle');
let current;

function removeScan(id) {
  if (id) void props.api(`/scans/${id}`, 'DELETE').catch(() => {});
}

function cancel() {
  const old = current;
  current = undefined;
  clearTimeout(old?.timer);
  removeScan(old?.id);
  qr.value = '';
}

function fail(text) {
  cancel();
  state.value = 'failed';
  message.value = text;
}

async function poll(scan) {
  if (current !== scan) return;
  if (Date.now() >= scan.expiresAt) {
    fail('二维码已过期，请重新生成。');
    return;
  }
  try {
    const result = await props.api(`/scans/${scan.id}`, 'POST');
    if (current !== scan) return;
    if (result.state === 'pending') {
      const remaining = Math.max(0, Math.ceil((scan.expiresAt - Date.now()) / 1000));
      message.value = `等待 App 确认 · 剩余 ${remaining} 秒`;
      scan.timer = setTimeout(() => void poll(scan), 2200);
    } else if (result.state === 'connected') {
      current = undefined;
      dialog.value?.close();
      emit('connected');
    } else {
      fail('二维码已失效，请重新生成。');
    }
  } catch (error) {
    if (current === scan) fail(error.message);
  }
}

async function open() {
  cancel();
  if (!dialog.value.open) dialog.value.showModal();
  const scan = {};
  current = scan;
  state.value = 'loading';
  message.value = '正在生成二维码…';
  try {
    const result = await props.api('/scans', 'POST');
    if (current !== scan) {
      removeScan(result.id);
      return;
    }
    Object.assign(scan, { id: result.id, expiresAt: result.expiresAt });
    qr.value = result.qr;
    state.value = 'waiting';
    message.value = '等待 App 确认…';
    scan.timer = setTimeout(() => void poll(scan), 1800);
  } catch (error) {
    if (current === scan) fail(error.message);
  }
}

defineExpose({ open });
onUnmounted(cancel);
</script>

<template>
  <dialog ref="dialog" aria-labelledby="scan-heading" class="w-[min(26rem,calc(100%-2rem))]" @close="cancel">
    <div class="p-6 sm:p-7">
      <div class="flex items-start justify-between gap-2">
        <div class="flex items-center gap-2.5"><ScanLine :size="21" class="text-accent" aria-hidden="true" /><h2 id="scan-heading" class="text-lg font-bold">扫码授权</h2></div>
        <button type="button" class="btn btn-quiet -mt-1 -mr-2 min-h-8 px-2" aria-label="关闭扫码窗口" @click="dialog.close()"><X :size="18" aria-hidden="true" /></button>
      </div>
      <p class="mt-2 text-sm leading-relaxed text-muted">打开森空岛 App 扫一扫，在 App 内确认授权。</p>
      <div v-if="state !== 'failed'" class="mx-auto mt-5 grid size-56 place-items-center rounded-xl border border-line" :class="qr ? 'bg-white' : 'bg-canvas'">
        <img v-if="qr" :src="qr" alt="森空岛登录二维码" class="size-52" width="208" height="208">
        <LoaderCircle v-else :size="24" class="animate-spin text-accent" aria-hidden="true" />
      </div>
      <p role="status" class="mt-4 text-center text-sm" :class="state === 'failed' ? 'text-alert' : 'text-muted'">{{ message }}</p>
      <button v-if="state === 'failed'" type="button" class="btn btn-primary mt-4 w-full" @click="open">重新生成二维码</button>
    </div>
  </dialog>
</template>
