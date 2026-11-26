<script setup>
import { onMounted, ref } from 'vue';
import { CalendarClock, LoaderCircle, Save } from '@lucide/vue';

const props = defineProps({ api: { type: Function, required: true } });
const schedule = ref(null);
const time = ref('');
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const notice = ref('');
const dateParts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function displayNext(at) {
  const parts = Object.fromEntries(dateParts.formatToParts(at).map(part => [part.type, part.value]));
  return `${parts.month} 月 ${parts.day} 日 ${parts.hour}:${parts.minute}`;
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    schedule.value = await props.api('/schedule');
    time.value = schedule.value.time;
  } catch (cause) {
    error.value = cause.message;
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  error.value = '';
  notice.value = '';
  try {
    schedule.value = await props.api('/schedule', 'PUT', { time: time.value });
    time.value = schedule.value.time;
    notice.value = '签到时间已保存。';
  } catch (cause) {
    error.value = cause.message;
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="mx-auto max-w-[52rem]">
    <div class="mb-6 sm:mb-7">
      <h1 id="daily-schedule-heading" class="text-[1.9rem] leading-tight font-bold tracking-[-.045em] sm:text-[2.4rem]">定时设置</h1>
      <p class="mt-1.5 text-sm text-muted">使用北京时间，适用于所有开启自动签到的账号。</p>
    </div>
    <section class="panel p-4 sm:p-6" aria-labelledby="daily-schedule-heading">
      <p v-if="loading" role="status" class="flex items-center gap-2 text-sm text-muted"><LoaderCircle :size="17" class="animate-spin" aria-hidden="true" />正在加载签到计划…</p>
      <div v-else class="grid gap-4">
        <p v-if="error" role="alert" class="rounded-lg bg-alert-soft px-3 py-2.5 text-sm text-alert">{{ error }}</p>
        <p v-if="notice" role="status" class="rounded-lg bg-positive-soft px-3 py-2.5 text-sm text-positive">{{ notice }}</p>
        <form v-if="schedule" class="grid gap-5 sm:grid-cols-[minmax(10rem,1fr)_minmax(14rem,1.4fr)]" @submit.prevent="save">
          <div class="grid justify-items-start gap-3">
            <div class="grid w-full gap-1.5">
              <label for="daily-time" class="text-sm font-semibold">每日开始时间（北京时间）</label>
              <input id="daily-time" v-model="time" class="field max-w-44 tabular-nums" type="time" step="60" required :disabled="saving" @input="notice = ''">
            </div>
            <button type="submit" class="btn btn-primary" :disabled="saving || !time || time === schedule.time">
              <Save :size="16" aria-hidden="true" />{{ saving ? '保存中…' : '保存时间' }}
            </button>
          </div>
          <div class="flex items-start gap-3 rounded-xl bg-canvas px-4 py-3.5 sm:p-4">
            <CalendarClock :size="18" class="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
            <div>
              <p class="text-sm font-semibold text-muted">下次开始</p>
              <p class="mt-1 text-lg font-bold tabular-nums">{{ displayNext(schedule.next_at) }}</p>
              <p class="mt-1 text-sm leading-relaxed text-muted">多个账号依次签到，当天已完成的账号会跳过。</p>
            </div>
          </div>
        </form>
        <button v-else type="button" class="btn btn-outline justify-self-start" @click="load">重试</button>
      </div>
    </section>
  </div>
</template>
