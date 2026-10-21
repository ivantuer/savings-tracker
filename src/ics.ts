import type { Position } from './types';

/** All-day calendar event on the sell-by date, with alerts 7, 3 and 1 day before. */
export function downloadSellReminder(p: Position) {
  if (!p.credit) return;
  const day = p.credit.sellBy.replace(/-/g, '');
  const next = new Date(`${p.credit.sellBy}T12:00:00`);
  next.setDate(next.getDate() + 1);
  const end = next.toISOString().slice(0, 10).replace(/-/g, '');
  const alarm = (d: number) =>
    `BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Sell ${p.name} in ${d} day(s)\r\nTRIGGER:-P${d}D\r\nEND:VALARM`;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Savings Tracker//EN', 'BEGIN:VEVENT',
    `UID:${p.id}@savings-tracker`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    `DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${end}`,
    `SUMMARY:Sell ${p.name} (credit grace period ends)`,
    `DESCRIPTION:${p.credit.bank ? `Credit: ${p.credit.bank}. ` : ''}Repay ${p.credit.owed} ${p.currency ?? 'UAH'}.`,
    alarm(7), alarm(3), alarm(1), 'END:VEVENT', 'END:VCALENDAR',
  ];
  const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/calendar' }));
  Object.assign(document.createElement('a'), { href: url, download: 'sell-reminder.ics' }).click();
  URL.revokeObjectURL(url);
}
