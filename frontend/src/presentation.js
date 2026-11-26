const dateTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const formatTime = at => dateTime.format(at);
export const formatDay = day => day ? day.replace(/^\d{4}-(\d{2})-(\d{2})$/, (_, month, date) => `${Number(month)} 月 ${Number(date)} 日`) : '';
export const accountName = account => account.label || account.roles[0]?.name || '森空岛账号';
export const gameNames = { arknights: '明日方舟', endfield: '终末地' };
export const runNames = { success: '已完成', partial: '部分完成', failed: '失败', reauth: '需重新授权' };
