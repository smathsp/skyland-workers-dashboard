<script setup>
import { computed, nextTick, ref } from 'vue';
import { BadgeCheck, CircleAlert, Clock3, Gamepad2, History, Minus, Play, Plus, QrCode, RefreshCw, Settings2, UsersRound, X } from '@lucide/vue';
import ScanDialog from './ScanDialog.vue';
import { accountName, formatDay, formatTime, gameNames, runNames } from './presentation.js';

const props = defineProps({
  data: { type: Object, required: true }, refreshing: Boolean,
  api: { type: Function, required: true }, refresh: { type: Function, required: true }, tell: { type: Function, required: true },
});
defineEmits(['refresh', 'schedule']);
const scan = ref(null);
const edit = ref(null);
const removeDialog = ref(null);
const selected = ref(null);
const editedLabel = ref('');
const editedEnabled = ref(false);
const editError = ref('');
const busy = ref(new Set());
const historyFilter = ref('all');
const expanded = ref(null);
const names = computed(() => new Map(props.data.accounts.map(account => [account.id, accountName(account)])));
const history = computed(() => props.data.runs.filter(run => historyFilter.value === 'all' || run.source === historyFilter.value));
const stats = computed(() => [
  { label: '已绑定账号', value: props.data.accounts.length, icon: UsersRound },
  { label: '已同步角色', value: props.data.accounts.reduce((sum, account) => sum + account.roles.length, 0), icon: Gamepad2 },
  { label: '今日已完成', value: `${props.data.accounts.filter(account => account.successful_day === props.data.day).length} / ${props.data.accounts.length}`, icon: BadgeCheck },
]);

function displayState(account) {
  if (account.needs_reauth) return { label: '需重新授权', class: 'tag-alert', icon: CircleAlert };
  if (account.successful_day === props.data.day) return { label: '今日已签到', class: 'tag-ok', icon: BadgeCheck };
  return { label: account.enabled ? '等待签到' : '待手动签到', class: 'tag-muted', icon: Clock3 };
}

async function connected() {
  try {
    await props.refresh();
    props.tell('授权成功，已同步游戏角色。');
  } catch (error) {
    props.tell(error.message, true);
  }
}

async function checkIn(account) {
  busy.value.add(account.id);
  props.tell('');
  try {
    const result = await props.api(`/accounts/${account.id}/sign`, 'POST');
    historyFilter.value = 'all';
    expanded.value = result.id;
    await props.refresh();
    props.tell(`签到结果 · ${runNames[result.status]}`, result.status !== 'success');
  } catch (error) {
    props.tell(error.message, true);
  } finally {
    busy.value.delete(account.id);
  }
}

async function openEdit(account) {
  selected.value = account;
  editedLabel.value = account.label;
  editedEnabled.value = Boolean(account.enabled);
  editError.value = '';
  await nextTick();
  edit.value.showModal();
}

async function updateAccount() {
  const account = selected.value;
  busy.value.add(account.id);
  editError.value = '';
  try {
    await props.api(`/accounts/${account.id}`, 'PATCH', { label: editedLabel.value, enabled: editedEnabled.value });
    edit.value.close();
    await props.refresh();
    props.tell('账号设置已保存。');
  } catch (error) {
    if (edit.value?.open) editError.value = error.message;
    else props.tell(error.message, true);
  } finally {
    busy.value.delete(account.id);
  }
}

async function confirmRemove() {
  edit.value.close();
  editError.value = '';
  await nextTick();
  removeDialog.value.showModal();
}

async function removeAccount() {
  const account = selected.value;
  busy.value.add(account.id);
  editError.value = '';
  try {
    await props.api(`/accounts/${account.id}`, 'DELETE');
    removeDialog.value.close();
    await props.refresh();
    props.tell('账号已移除。');
  } catch (error) {
    if (removeDialog.value?.open) editError.value = error.message;
    else props.tell(error.message, true);
  } finally {
    busy.value.delete(account.id);
  }
}

function updateExpanded(event, id) {
  if (event.target.open) expanded.value = id;
  else if (expanded.value === id) expanded.value = null;
}

function detailText(detail) {
  if (detail.awards?.length) return detail.awards.join('、');
  if (detail.status === 'already') return '当天已签到';
  return detail.message || '签到成功';
}
</script>

<template>
  <div class="mb-6 flex flex-wrap items-end justify-between gap-4 sm:mb-7">
    <div>
      <h1 class="text-[1.9rem] leading-tight font-bold tracking-[-.045em] sm:text-[2.4rem]">签到面板</h1>
      <div v-if="data.day" class="mt-1.5 flex flex-wrap items-center gap-x-2 text-sm text-muted">
        <span>{{ formatDay(data.day) }} · 北京时间</span>
        <button v-if="data.schedule" type="button" class="rounded-md px-1.5 py-1 text-sm font-medium text-accent hover:bg-accent-soft"
          aria-label="修改自动签到时间" @click="$emit('schedule')">每天 {{ data.schedule.time }} 自动签到</button>
      </div>
    </div>
    <div class="flex items-center gap-2">
      <button class="btn btn-outline size-10 px-0" type="button" title="刷新签到状态" aria-label="刷新签到状态" :disabled="refreshing" @click="$emit('refresh')">
        <RefreshCw :size="17" aria-hidden="true" :class="{ 'animate-spin': refreshing }" />
      </button>
      <button class="btn btn-primary" type="button" @click="scan.open()"><QrCode :size="17" aria-hidden="true" />扫码添加账号</button>
    </div>
  </div>

  <dl class="mb-6 grid grid-cols-3 gap-2.5 sm:gap-4">
    <div v-for="stat in stats" :key="stat.label" class="panel relative min-w-0 px-3 py-3.5 sm:px-5 sm:py-4.5">
      <dt class="text-sm font-medium text-muted">{{ stat.label }}</dt>
      <dd class="mt-1.5 text-2xl leading-none font-bold tracking-tight tabular-nums sm:text-3xl">{{ data.day ? stat.value : '—' }}</dd>
      <component :is="stat.icon" :size="19" class="absolute top-4.5 right-5 hidden text-accent sm:block" aria-hidden="true" />
    </div>
  </dl>

  <div class="grid items-start gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
    <section class="panel min-w-0" aria-labelledby="accounts-heading">
      <div class="flex items-center gap-2.5 border-b border-line px-4 py-4 sm:px-5">
        <UsersRound :size="18" class="text-accent" aria-hidden="true" /><h2 id="accounts-heading" class="font-bold">签到账号</h2>
      </div>
      <p v-if="!data.accounts.length" class="px-4 py-7 text-sm text-muted sm:px-5">{{ refreshing ? '正在加载账号…' : '扫码添加账号后，绑定角色会显示在这里。' }}</p>
      <article v-for="account in data.accounts" :key="account.id" class="border-b border-line px-4 py-4 last:border-b-0 sm:px-5">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0 flex-1">
            <h3 class="font-bold wrap-anywhere">{{ accountName(account) }}</h3>
            <p class="mt-1 text-sm text-muted">{{ account.enabled ? '自动签到已开启' : '自动签到已暂停' }}</p>
          </div>
          <span class="tag shrink-0" :class="displayState(account).class"><component :is="displayState(account).icon" :size="14" aria-hidden="true" />{{ displayState(account).label }}</span>
        </div>
        <ul v-if="account.roles.length" class="mt-3 grid gap-2.5 rounded-xl bg-canvas px-3 py-3 sm:px-3.5">
          <li v-for="role in account.roles" :key="role.key" class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
            <span class="w-15 shrink-0 font-semibold text-ink">{{ gameNames[role.game] }}</span>
            <span class="min-w-0 text-muted wrap-anywhere">{{ role.name }}</span>
            <span v-if="role.channel" class="text-muted">· {{ role.channel }}</span>
          </li>
        </ul>
        <p v-else class="mt-3 text-sm text-muted">这个账号暂无已绑定角色。</p>
        <div class="mt-4 flex flex-wrap gap-2">
          <button v-if="account.needs_reauth" type="button" class="btn btn-primary" @click="scan.open()"><QrCode :size="16" aria-hidden="true" />重新扫码</button>
          <button v-else type="button" class="btn btn-outline" :disabled="busy.has(account.id)" @click="checkIn(account)">
            <Play :size="15" aria-hidden="true" />{{ busy.has(account.id) ? '正在处理…' : '立即签到' }}
          </button>
          <button type="button" class="btn btn-quiet" :disabled="busy.has(account.id)" @click="openEdit(account)"><Settings2 :size="16" aria-hidden="true" />账号设置</button>
        </div>
      </article>
    </section>

    <section class="panel min-w-0" aria-labelledby="history-heading">
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 sm:px-5">
        <div class="flex items-center gap-2.5 py-1"><History :size="18" class="text-accent" aria-hidden="true" /><h2 id="history-heading" class="font-bold">签到记录</h2></div>
        <div v-if="data.runs.length" aria-label="筛选签到记录" class="flex gap-0.5 rounded-lg bg-canvas p-0.5">
          <button v-for="option in [{ id: 'all', label: '全部' }, { id: 'scheduled', label: '自动' }, { id: 'manual', label: '手动' }]" :key="option.id"
            type="button" :aria-pressed="historyFilter === option.id" class="min-h-8 rounded-md px-2.5 text-sm font-medium"
            :class="historyFilter === option.id ? 'bg-white text-ink shadow-sm' : 'text-muted hover:text-ink'" @click="historyFilter = option.id">{{ option.label }}</button>
        </div>
      </div>
      <p v-if="!history.length" class="px-4 py-7 text-sm text-muted sm:px-5">{{ data.runs.length ? '这个筛选条件下暂无记录。' : '签到完成后，结果会显示在这里。' }}</p>
      <details v-for="run in history" :key="run.id" :open="expanded === run.id" class="group border-b border-line last:border-b-0" @toggle="updateExpanded($event, run.id)">
        <summary class="flex list-none items-center justify-between gap-2 px-4 py-3.5 hover:bg-canvas sm:px-5 [&::-webkit-details-marker]:hidden">
          <div class="min-w-0">
            <p class="truncate text-sm font-bold">{{ names.get(run.account_id) || '森空岛账号' }}</p>
            <p class="mt-0.5 text-sm text-muted tabular-nums">{{ formatTime(run.at) }} · {{ run.source === 'manual' ? '手动' : '自动' }}</p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <span class="tag" :class="run.status === 'success' ? 'tag-ok' : 'tag-alert'">{{ runNames[run.status] }}</span>
            <component :is="expanded === run.id ? Minus : Plus" :size="15" class="text-muted" aria-hidden="true" />
          </div>
        </summary>
        <ul class="mx-4 mb-3.5 grid gap-2.5 rounded-lg bg-canvas p-3 text-sm sm:mx-5">
          <li v-for="(detail, index) in run.details" :key="detail.key || index" class="wrap-anywhere text-muted">
            <p v-if="detail.game" class="mb-0.5 font-semibold text-ink">{{ gameNames[detail.game] }} · {{ detail.name }}</p>
            <p>{{ detailText(detail) }}</p>
          </li>
        </ul>
      </details>
    </section>
  </div>
  <ScanDialog ref="scan" :api="api" @connected="connected" />

  <dialog ref="edit" aria-labelledby="edit-heading" class="w-[min(27rem,calc(100%-2rem))]">
    <form v-if="selected" class="grid gap-4 p-6 sm:p-7" @submit.prevent="updateAccount">
      <div class="flex items-center justify-between gap-3"><h2 id="edit-heading" class="text-lg font-bold">账号设置</h2><button type="button" class="btn btn-quiet -mr-2 min-h-8 px-2" aria-label="关闭设置" @click="edit.close()"><X :size="18" aria-hidden="true" /></button></div>
      <div class="grid gap-1.5"><label for="account-label" class="text-sm font-semibold">备注</label><input id="account-label" v-model="editedLabel" class="field" type="text" maxlength="36" autocomplete="off" autofocus :placeholder="accountName(selected)"></div>
      <label class="flex items-center gap-2.5 text-sm font-medium"><input v-model="editedEnabled" class="size-4 accent-accent" type="checkbox">启用自动签到</label>
      <p v-if="editError" role="alert" class="text-sm text-alert">{{ editError }}</p>
      <div class="mt-1 flex flex-wrap items-center justify-between gap-2"><button type="button" class="btn btn-danger -ml-2" :disabled="busy.has(selected.id)" @click="confirmRemove">移除账号</button><button type="submit" class="btn btn-primary" :disabled="busy.has(selected.id)">保存设置</button></div>
    </form>
  </dialog>

  <dialog ref="removeDialog" aria-labelledby="remove-heading" class="w-[min(27rem,calc(100%-2rem))]">
    <div v-if="selected" class="grid gap-4 p-6 sm:p-7">
      <h2 id="remove-heading" class="text-lg font-bold">移除账号？</h2>
      <p class="text-sm text-muted wrap-anywhere">「{{ accountName(selected) }}」的凭证和签到记录将从面板删除。</p>
      <p v-if="editError" role="alert" class="text-sm text-alert">{{ editError }}</p>
      <div class="flex justify-end gap-2"><button type="button" class="btn btn-outline" @click="removeDialog.close()">取消</button><button type="button" class="btn bg-alert text-white" :disabled="busy.has(selected.id)" @click="removeAccount">确认移除</button></div>
    </div>
  </dialog>
</template>
