<script setup>
import { onMounted, onUnmounted, ref } from 'vue';
import { BadgeCheck, Copy, LoaderCircle, ShieldCheck } from '@lucide/vue';

const props = defineProps({ api: { type: Function, required: true } });
const emit = defineEmits(['enabled']);
const settings = ref(null);
const pending = ref(null);
const password = ref('');
const code = ref('');
const busy = ref(false);
const error = ref('');
const notice = ref('');
let mounted = true;

async function load() {
  busy.value = true;
  error.value = '';
  try {
    settings.value = await props.api('/auth/totp');
  } catch (cause) {
    error.value = cause.message;
  } finally {
    busy.value = false;
  }
}

async function begin() {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const result = await props.api('/auth/totp/setup', 'POST', { password: password.value });
    if (!mounted) {
      await props.api(`/auth/totp/setup/${result.id}`, 'DELETE').catch(() => {});
      return;
    }
    pending.value = result;
    password.value = '';
  } catch (cause) {
    error.value = cause.message;
  } finally {
    busy.value = false;
  }
}

async function confirm() {
  busy.value = true;
  error.value = '';
  try {
    settings.value = await props.api('/auth/totp/confirm', 'POST', { id: pending.value.id, code: code.value });
    pending.value = null;
    code.value = '';
    notice.value = '动态验证码已启用。';
    emit('enabled');
  } catch (cause) {
    error.value = cause.message;
  } finally {
    busy.value = false;
  }
}

async function cancel() {
  const setup = pending.value;
  pending.value = null;
  code.value = '';
  error.value = '';
  notice.value = '';
  if (!setup) return;
  await props.api(`/auth/totp/setup/${setup.id}`, 'DELETE').catch(() => {});
}

async function copyConfig() {
  try {
    await navigator.clipboard.writeText(pending.value.uri);
    notice.value = '已复制 Bitwarden 配置。';
  } catch {
    notice.value = '剪贴板不可用，可以用 Bitwarden 扫码。';
  }
}

onMounted(load);
onUnmounted(() => {
  mounted = false;
  if (pending.value && !busy.value) void cancel();
});
</script>

<template>
  <div class="mx-auto max-w-[52rem]">
    <div class="mb-6 sm:mb-7">
      <h1 id="security-heading" class="text-[1.9rem] leading-tight font-bold tracking-[-.045em] sm:text-[2.4rem]">登录安全</h1>
      <p class="mt-1.5 text-sm text-muted">使用 Bitwarden 生成的动态验证码登录管理面板。</p>
    </div>
    <section class="panel grid gap-4 p-4 sm:p-6" aria-labelledby="security-heading">
      <p v-if="error" role="alert" class="rounded-lg bg-alert-soft px-3 py-2.5 text-sm text-alert">{{ error }}</p>
      <p v-if="notice" role="status" class="rounded-lg bg-positive-soft px-3 py-2.5 text-sm text-positive">{{ notice }}</p>
      <template v-if="!settings">
        <p v-if="busy" role="status" class="flex items-center gap-2 text-sm text-muted"><LoaderCircle :size="17" class="animate-spin" aria-hidden="true" />正在加载登录设置…</p>
        <button v-else type="button" class="btn btn-outline justify-self-start" @click="load">重试</button>
      </template>
      <div v-else-if="settings.enabled" class="flex items-start gap-3">
        <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-positive-soft text-positive"><BadgeCheck :size="20" aria-hidden="true" /></span>
        <div>
          <h2 class="font-bold">管理员动态验证码已启用</h2>
          <p class="mt-1 text-sm text-muted">登录时输入 {{ settings.digits }} 位验证码，每 {{ settings.period }} 秒更新一次。</p>
        </div>
      </div>
      <form v-else-if="!pending" class="grid max-w-sm gap-3" @submit.prevent="begin">
        <p class="text-sm leading-relaxed text-muted">首次绑定时需要确认当前管理员密码。验证 Bitwarden 生成的验证码后，登录方式会切换为动态验证码。</p>
        <label for="security-password" class="text-sm font-semibold">当前管理员密码</label>
        <input id="security-password" v-model="password" class="field" type="password" autocomplete="current-password" maxlength="256" required>
        <button type="submit" class="btn btn-primary justify-self-start" :disabled="busy"><ShieldCheck :size="16" aria-hidden="true" />{{ busy ? '正在生成…' : '设置动态验证码' }}</button>
      </form>
      <div v-else class="grid gap-5 sm:grid-cols-[14rem_minmax(0,1fr)]">
        <div class="grid size-52 place-items-center rounded-xl border border-line bg-white sm:size-56">
          <img :src="pending.qr" width="208" height="208" class="size-48 sm:size-52" alt="Bitwarden 动态验证码绑定二维码">
        </div>
        <div class="grid min-w-0 content-start gap-3">
          <p class="text-sm leading-relaxed text-muted">用 Bitwarden 扫码，或者复制配置到密码管理器的验证器密钥字段。请在 10 分钟内完成验证。</p>
          <button type="button" class="btn btn-outline justify-self-start" @click="copyConfig"><Copy :size="16" aria-hidden="true" />复制 Bitwarden 配置</button>
          <details class="min-w-0 text-sm text-muted">
            <summary class="font-medium text-accent">查看手动输入的密钥</summary>
            <p class="mt-2 rounded-lg bg-canvas p-2 font-mono break-all select-all">{{ pending.seed }}</p>
            <p class="mt-1">SHA-1 · {{ pending.digits }} 位 · {{ pending.period }} 秒</p>
          </details>
          <form class="grid gap-2" @submit.prevent="confirm">
            <label for="setup-code" class="text-sm font-semibold">Bitwarden 的 {{ pending.digits }} 位验证码</label>
            <input id="setup-code" v-model="code" class="field font-mono tabular-nums" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="16" required>
            <div class="mt-1 flex flex-wrap gap-2">
              <button type="submit" class="btn btn-primary" :disabled="busy">{{ busy ? '正在验证…' : '验证并启用' }}</button>
              <button type="button" class="btn btn-quiet" :disabled="busy" @click="cancel">取消绑定</button>
            </div>
          </form>
        </div>
      </div>
    </section>
  </div>
</template>
