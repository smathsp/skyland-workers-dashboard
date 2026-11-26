<script setup>
import { computed, nextTick, onMounted, ref } from 'vue';
import { BadgeCheck, Bell, CircleAlert, ExternalLink, LoaderCircle, Send, Settings2, X } from '@lucide/vue';
import { formatTime } from './presentation.js';
import { providerInfo } from './providers.js';

const props = defineProps({ api: { type: Function, required: true } });
const channels = ref({});
const showConfigured = ref(false);
const visibleProviders = computed(() => showConfigured.value ? providerInfo.filter(item => channels.value[item.id]) : providerInfo);
const loading = ref(true);
const loadError = ref('');
const notice = ref(null);
const dialog = ref(null);
const provider = ref(null);
const form = ref(null);
const saveError = ref('');
const saveBusy = ref(false);
const testing = ref(new Set());
const removing = ref(false);
const colors = { violet: 'bg-violet-100 text-violet-800', green: 'bg-emerald-100 text-emerald-800', blue: 'bg-accent-soft text-accent' };

function tell(text, error = false) {
  notice.value = { text, error };
}

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const result = await props.api('/notifications');
    channels.value = Object.fromEntries(result.channels.map(channel => [channel.provider, channel]));
  } catch (error) {
    loadError.value = error.message;
  } finally {
    loading.value = false;
  }
}

async function edit(item) {
  const saved = channels.value[item.id];
  provider.value = item;
  form.value = {
    secret: '',
    extra: '',
    clear_extra: false,
    enabled: saved ? Boolean(saved.enabled) : true,
    result_mode: saved?.result_mode ?? 'all',
    include_manual: Boolean(saved?.include_manual),
  };
  saveError.value = '';
  removing.value = false;
  await nextTick();
  dialog.value.showModal();
}

function reset() {
  if (form.value) {
    form.value.secret = '';
    form.value.extra = '';
  }
  removing.value = false;
  saveError.value = '';
}

async function save() {
  const id = provider.value.id;
  saveBusy.value = true;
  saveError.value = '';
  try {
    channels.value[id] = await props.api(`/notifications/${id}`, 'PUT', form.value);
    dialog.value.close();
    tell(`${provider.value.name} 配置已保存。`);
  } catch (error) {
    saveError.value = error.message;
  } finally {
    saveBusy.value = false;
  }
}

async function remove() {
  const id = provider.value.id;
  saveBusy.value = true;
  saveError.value = '';
  try {
    await props.api(`/notifications/${id}`, 'DELETE');
    delete channels.value[id];
    dialog.value.close();
    tell(`${provider.value.name} 配置已清除。`);
  } catch (error) {
    saveError.value = error.message;
  } finally {
    saveBusy.value = false;
  }
}

async function test(item) {
  testing.value.add(item.id);
  notice.value = null;
  try {
    const result = await props.api(`/notifications/${item.id}/test`, 'POST');
    const row = channels.value[item.id];
    if (row) {
      row.last_at = result.at;
      row.last_status = result.status;
      row.last_message = result.message;
      row.last_kind = 'test';
    }
    tell(result.status === 'accepted' ? `${item.name} 已受理测试消息，请到接收端查看。` : result.message, result.status !== 'accepted');
  } catch (error) {
    tell(error.message, true);
  } finally {
    testing.value.delete(item.id);
  }
}

onMounted(load);
</script>

<template>
  <div class="mb-6 flex flex-wrap items-end justify-between gap-3 sm:mb-7">
    <div>
      <h1 class="text-[1.9rem] leading-tight font-bold tracking-[-.045em] sm:text-[2.4rem]">消息推送</h1>
      <p class="mt-1.5 text-sm text-muted">选择接收签到结果的平台。</p>
    </div>
    <label v-if="!loading && !loadError" class="flex min-h-10 items-center gap-2 text-sm font-medium text-muted">
      <input v-model="showConfigured" type="checkbox" class="size-4 accent-accent">仅显示已配置
    </label>
  </div>
  <p v-if="notice" :role="notice.error ? 'alert' : 'status'" class="mb-5 rounded-xl border px-4 py-3 text-sm"
    :class="notice.error ? 'border-[#f7dbd0] bg-alert-soft text-alert' : 'border-[#cfebdf] bg-positive-soft text-positive'">{{ notice.text }}</p>
  <p v-if="loading" role="status" class="panel flex items-center gap-2 p-4 text-sm text-muted"><LoaderCircle :size="17" class="animate-spin" aria-hidden="true" />正在加载推送配置…</p>
  <div v-else-if="loadError" class="panel flex flex-wrap items-center justify-between gap-2 p-4">
    <p role="alert" class="flex items-center gap-2 text-sm text-alert"><CircleAlert :size="17" aria-hidden="true" />{{ loadError }}</p>
    <button class="btn btn-outline" type="button" @click="load">重试</button>
  </div>
  <p v-else-if="!visibleProviders.length" class="panel p-5 text-sm text-muted">暂无已配置的推送渠道。</p>
  <div v-else class="grid items-start gap-3 min-[540px]:grid-cols-2 lg:grid-cols-3">
    <article v-for="item in visibleProviders" :key="item.id" class="panel min-w-0 px-3.5 py-3.5 sm:px-4">
      <div class="flex items-center gap-3">
        <span class="grid size-9 shrink-0 place-items-center rounded-[.6rem] font-bold" :class="colors[item.color]" aria-hidden="true">{{ item.mark }}</span>
        <div class="min-w-0 flex-1">
          <h2 class="leading-snug font-bold wrap-anywhere">{{ item.name }}</h2>
          <p class="mt-0.5 text-sm leading-snug text-muted">{{ item.destination }}</p>
        </div>
        <template v-if="channels[item.id]">
          <span v-if="channels[item.id].enabled" class="tag tag-ok shrink-0"><BadgeCheck :size="14" aria-hidden="true" />已启用</span>
          <span v-else class="tag tag-muted shrink-0">已暂停</span>
        </template>
        <button v-else type="button" class="btn btn-outline shrink-0 px-2.5" :aria-label="`配置 ${item.name}`" @click="edit(item)">配置</button>
      </div>
      <div v-if="channels[item.id]" class="mt-3 grid gap-2.5 border-t border-line pt-2.5">
        <p class="text-sm text-muted">{{ channels[item.id].result_mode === 'failures' ? '仅推送异常' : '推送全部结果' }} · {{ channels[item.id].include_manual ? '自动和手动签到' : '自动签到' }}</p>
        <div v-if="channels[item.id].last_at" class="rounded-lg bg-canvas p-2.5 text-sm text-muted">
          <p :class="channels[item.id].last_status === 'failed' ? 'text-alert' : 'text-ink'">{{ channels[item.id].last_message }}</p>
          <p class="mt-0.5">{{ formatTime(channels[item.id].last_at) }} · {{ channels[item.id].last_kind === 'test' ? '测试' : '签到推送' }}</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button type="button" class="btn btn-outline" :disabled="testing.has(item.id)" @click="edit(item)">
            <Settings2 :size="16" aria-hidden="true" />编辑配置
          </button>
          <button type="button" class="btn btn-quiet" :disabled="testing.has(item.id)" @click="test(item)">
            <Send :size="15" aria-hidden="true" />{{ testing.has(item.id) ? '发送中…' : '发送测试' }}
          </button>
        </div>
      </div>
    </article>
  </div>
  <dialog ref="dialog" aria-labelledby="channel-heading" class="w-[min(29rem,calc(100%-2rem))]" @close="reset">
    <form v-if="provider" class="grid gap-4 p-6 sm:p-7" @submit.prevent="save">
      <div class="flex items-start justify-between gap-2">
        <div class="flex items-center gap-2.5"><Bell :size="20" class="text-accent" aria-hidden="true" /><h2 id="channel-heading" class="text-lg font-bold">{{ provider.name }}</h2></div>
        <button type="button" class="btn btn-quiet -mt-1 -mr-2 min-h-8 px-2" aria-label="关闭推送设置" @click="dialog.close()"><X :size="18" aria-hidden="true" /></button>
      </div>
      <template v-if="removing">
        <p class="text-sm text-muted">清除后，该渠道的凭证和设置会被删除。</p>
        <p v-if="saveError" role="alert" class="text-sm text-alert">{{ saveError }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn btn-outline" @click="removing = false">取消</button>
          <button type="button" class="btn bg-alert text-white" :disabled="saveBusy" @click="remove">确认清除</button>
        </div>
      </template>
      <template v-else>
        <div class="grid gap-1.5">
          <div class="flex items-baseline justify-between gap-2">
            <label for="push-key" class="text-sm font-semibold">{{ provider.key }}</label>
            <a :href="provider.guide" target="_blank" rel="noreferrer" class="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">凭证获取说明<ExternalLink :size="13" aria-hidden="true" /></a>
          </div>
          <input id="push-key" v-model="form.secret" class="field" type="password" maxlength="320" autocomplete="new-password" autofocus
            :required="!channels[provider.id]" :placeholder="channels[provider.id] ? '已保存 · 填写新值可更换' : `粘贴 ${provider.key}`">
          <p v-if="provider.hint" class="text-sm leading-relaxed text-muted">{{ provider.hint }}</p>
        </div>
        <div v-if="provider.extra" class="grid gap-1.5">
          <label for="push-extra" class="text-sm font-semibold">{{ provider.extra.label }}</label>
          <input id="push-extra" v-model="form.extra" class="field" type="password" maxlength="256" autocomplete="new-password" :disabled="form.clear_extra"
            :required="provider.extra.required && !channels[provider.id]?.has_extra" :placeholder="channels[provider.id]?.has_extra ? '已保存 · 填写新值可更换' : provider.extra.placeholder">
          <label v-if="!provider.extra.required && channels[provider.id]?.has_extra" class="flex items-center gap-2.5 text-sm text-muted">
            <input v-model="form.clear_extra" type="checkbox" class="size-4 accent-accent" @change="form.extra = ''">移除已保存的签名密钥
          </label>
        </div>
        <label class="grid gap-1.5 text-sm font-semibold">推送范围
          <select v-model="form.result_mode" class="field text-sm font-normal">
            <option value="all">全部签到结果</option><option value="failures">仅失败、部分完成或需重新授权</option>
          </select>
        </label>
        <div class="grid gap-2.5 rounded-xl bg-canvas px-3 py-3 text-sm">
          <label class="flex items-center gap-2.5"><input v-model="form.enabled" type="checkbox" class="size-4 accent-accent">启用该渠道的签到推送</label>
          <label class="flex items-center gap-2.5"><input v-model="form.include_manual" type="checkbox" class="size-4 accent-accent">同时推送手动签到结果</label>
        </div>
        <p v-if="saveError" role="alert" class="text-sm text-alert">{{ saveError }}</p>
        <div class="mt-1 flex flex-wrap items-center justify-end gap-2">
          <button v-if="channels[provider.id]" type="button" class="btn btn-danger mr-auto -ml-2" :disabled="saveBusy" @click="removing = true">清除配置</button>
          <button type="submit" class="btn btn-primary" :disabled="saveBusy">{{ saveBusy ? '保存中…' : '保存配置' }}</button>
        </div>
      </template>
    </form>
  </dialog>
</template>
