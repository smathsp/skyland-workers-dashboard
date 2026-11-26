<script setup>
import { defineAsyncComponent, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { Bell, CalendarCheck, CircleAlert, Clock3, CloudCheck, LoaderCircle, LockKeyhole, LogOut, ShieldCheck } from '@lucide/vue';
import PageLoadState from './PageLoadState.vue';

function lazyPage(loader) {
  return defineAsyncComponent({ loader, loadingComponent: PageLoadState, errorComponent: PageLoadState });
}
const DashboardView = lazyPage(() => import('./DashboardView.vue'));
const NotificationsView = lazyPage(() => import('./NotificationsView.vue'));
const ScheduleView = lazyPage(() => import('./ScheduleView.vue'));
const LoginSecurityView = lazyPage(() => import('./LoginSecurityView.vue'));

const session = ref('loading');
const page = ref('dashboard');
const credential = ref('');
const mode = ref('password');
const submitting = ref(false);
const loginError = ref('');
const data = shallowRef({ day: '', accounts: [], runs: [] });
const refreshing = ref(false);
const notice = ref(null);
let requestVersion = 0;

function tell(text, error = false) {
  notice.value = text ? { text, error } : null;
}

function resetSession() {
  requestVersion++;
  refreshing.value = false;
  data.value = { day: '', accounts: [], runs: [] };
  tell('');
  session.value = 'anonymous';
  credential.value = '';
  page.value = 'dashboard';
}

async function api(path, method = 'GET', body) {
  const options = { method, credentials: 'same-origin', cache: 'no-store' };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(`/api${path}`, options);
  } catch {
    throw new Error('网络连接中断，请稍后重试。');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== '/session') {
      resetSession();
      await refreshMode();
      loginError.value = '面板会话已结束，请重新登录。';
    }
    throw new Error(result.error || '暂时无法完成操作，请稍后重试。');
  }
  return result;
}

async function refresh() {
  const version = ++requestVersion;
  refreshing.value = true;
  try {
    const next = await api('/dashboard');
    if (version === requestVersion) data.value = next;
  } finally {
    if (version === requestVersion) refreshing.value = false;
  }
}

async function refreshWithFeedback() {
  tell('');
  try {
    await refresh();
  } catch (error) {
    if (session.value === 'active') tell(error.message, true);
  }
}

async function refreshMode() {
  const result = await api('/session').catch(() => null);
  if (result?.mode && result.mode !== mode.value) {
    mode.value = result.mode;
    credential.value = '';
  }
}

async function initialize() {
  session.value = 'loading';
  loginError.value = '';
  try {
    const result = await api('/session?include=dashboard').catch(() => api('/session'));
    mode.value = result.mode ?? 'password';
    if (result.dashboard) data.value = result.dashboard;
    session.value = result.authenticated ? 'active' : 'anonymous';
    if (result.authenticated && !result.dashboard) await refreshWithFeedback();
  } catch (error) {
    session.value = 'error';
    loginError.value = error.message;
  }
}

async function signIn() {
  submitting.value = true;
  loginError.value = '';
  try {
    const body = mode.value === 'totp' ? { code: credential.value } : { password: credential.value };
    await api('/session', 'POST', body);
    credential.value = '';
    session.value = 'active';
    await refreshWithFeedback();
  } catch (error) {
    await refreshMode();
    loginError.value = error.message;
  } finally {
    submitting.value = false;
  }
}

async function signOut() {
  submitting.value = true;
  try {
    const result = await api('/session', 'DELETE');
    mode.value = result.mode ?? mode.value;
    resetSession();
  } catch (error) {
    if (session.value === 'active') tell(error.message, true);
  } finally {
    submitting.value = false;
  }
}

function selectPage(next) {
  if (page.value === next) return;
  tell('');
  page.value = next;
  if (next === 'dashboard') void refreshWithFeedback();
}

function refreshOnReturn() {
  if (!document.hidden && session.value === 'active' && page.value === 'dashboard' && !refreshing.value) void refreshWithFeedback();
}

onMounted(() => {
  void initialize();
  document.addEventListener('visibilitychange', refreshOnReturn);
});
onUnmounted(() => document.removeEventListener('visibilitychange', refreshOnReturn));
</script>

<template>
  <header class="border-b border-line bg-white">
    <div class="shell flex min-h-16 flex-wrap items-center justify-between gap-x-4 md:min-h-17 md:flex-nowrap lg:gap-x-6">
      <div class="flex min-w-0 items-center gap-3 py-3">
        <span class="grid size-9 shrink-0 place-items-center rounded-[.7rem] bg-ink text-white" aria-hidden="true"><CloudCheck :size="21" /></span>
        <span class="truncate text-base font-bold tracking-tight">森空岛签到</span>
      </div>
      <nav v-if="session === 'active'" aria-label="面板导航" class="order-last grid w-full grid-cols-4 self-stretch gap-1 md:order-none md:mr-auto md:flex md:w-auto md:gap-4 lg:gap-6">
        <button v-for="item in [{ id: 'dashboard', label: '签到面板', icon: CalendarCheck }, { id: 'notifications', label: '消息推送', icon: Bell }, { id: 'schedule', label: '定时设置', icon: Clock3 }, { id: 'security', label: '登录安全', icon: ShieldCheck }]"
          :key="item.id" type="button" :aria-current="page === item.id ? 'page' : undefined"
          :class="page === item.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-ink'"
          class="flex min-h-11 items-center justify-center gap-1 whitespace-nowrap border-b-2 px-0.5 py-2.5 text-sm font-semibold md:gap-2"
          @click="selectPage(item.id)">
          <component :is="item.icon" :size="16" class="hidden min-[380px]:block" aria-hidden="true" />{{ item.label }}
        </button>
      </nav>
      <button v-if="session === 'active'" type="button" class="btn btn-quiet -mr-2.5 shrink-0" :disabled="submitting" @click="signOut">
        <LogOut :size="16" aria-hidden="true" />退出
      </button>
    </div>
  </header>

  <main v-if="session === 'active'" class="shell py-7 sm:py-10">
    <p v-if="notice" :role="notice.error ? 'alert' : 'status'" class="mb-5 flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm"
      :class="notice.error ? 'border-[#f7dbd0] bg-alert-soft text-alert' : 'border-[#cfebdf] bg-positive-soft text-positive'">
      <CircleAlert v-if="notice.error" :size="17" class="mt-0.5 shrink-0" aria-hidden="true" />{{ notice.text }}
    </p>
    <DashboardView v-if="page === 'dashboard'" :data="data" :refreshing="refreshing" :api="api" :refresh="refresh" :tell="tell" @refresh="refreshWithFeedback" @schedule="selectPage('schedule')" />
    <NotificationsView v-else-if="page === 'notifications'" :api="api" />
    <ScheduleView v-else-if="page === 'schedule'" :api="api" />
    <LoginSecurityView v-else :api="api" @enabled="mode = 'totp'" />
  </main>

  <main v-else class="shell py-14 sm:py-23">
    <section class="panel mx-auto max-w-[29rem] p-6 sm:p-9" aria-labelledby="login-heading">
      <div class="mb-5 grid size-11 place-items-center rounded-xl bg-accent-soft text-accent" aria-hidden="true"><LockKeyhole :size="21" /></div>
      <h1 id="login-heading" class="text-2xl font-bold tracking-tight sm:text-[1.75rem]">登录签到面板</h1>
      <p v-if="session === 'loading'" role="status" class="mt-4 flex items-center gap-2 text-muted"><LoaderCircle :size="17" class="animate-spin" />正在检查会话…</p>
      <template v-else>
        <p v-if="loginError" role="alert" class="my-4 rounded-lg bg-alert-soft px-3 py-2.5 text-sm text-alert">{{ loginError }}</p>
        <form v-if="session === 'anonymous'" class="mt-6 grid gap-3" @submit.prevent="signIn">
          <template v-if="mode === 'totp'">
            <label for="admin-code" class="text-sm font-semibold">动态验证码</label>
            <input id="admin-code" v-model="credential" class="field font-mono tabular-nums" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="16" required>
            <p class="text-sm text-muted">输入 Bitwarden 当前显示的 8 位验证码。</p>
          </template>
          <template v-else>
            <label for="admin-password" class="text-sm font-semibold">管理员密码</label>
            <input id="admin-password" v-model="credential" class="field" type="password" autocomplete="current-password" maxlength="256" required>
          </template>
          <button class="btn btn-primary mt-1 min-h-11" type="submit" :disabled="submitting">{{ submitting ? '正在登录…' : '登录' }}</button>
        </form>
        <button v-else class="btn btn-outline" type="button" @click="initialize">重新连接</button>
      </template>
    </section>
  </main>
</template>
