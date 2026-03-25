import { db } from '../db';

const LS_KEYS = [
  'hisaab_onboarded', 'hisaab_user_name', 'hisaab_primary_currency',
  'hisaab_lang', 'hisaab_app_mode', 'hisaab_identifier', 'hisaab_data_version',
];

export async function exportAllData(): Promise<string> {
  const [accounts, transactions, loans, emiSchedules, goals, activityLog, upcomingExpenses, splitGroups, groupExpenses, groupSettlements] = await Promise.all([
    db.accounts.toArray(),
    db.transactions.toArray(),
    db.loans.toArray(),
    db.emiSchedules.toArray(),
    db.goals.toArray(),
    db.activityLog.toArray(),
    db.upcomingExpenses.toArray(),
    db.splitGroups.toArray(),
    db.groupExpenses.toArray(),
    db.groupSettlements.toArray(),
  ]);

  const settings: Record<string, string | null> = {};
  LS_KEYS.forEach(k => { settings[k] = localStorage.getItem(k); });

  return JSON.stringify({
    version: 3,
    exportedAt: new Date().toISOString(),
    settings,
    data: { accounts, transactions, loans, emiSchedules, goals, activityLog, upcomingExpenses, splitGroups, groupExpenses, groupSettlements },
  }, null, 2);
}

export async function importData(json: string): Promise<{ success: boolean; message: string }> {
  try {
    const parsed = JSON.parse(json);
    if (!parsed.data || !parsed.version) {
      return { success: false, message: 'Invalid backup file format' };
    }

    // Clear all tables
    await db.transaction('rw', db.accounts, db.transactions, db.loans, db.emiSchedules, db.goals, db.activityLog, db.upcomingExpenses, db.splitGroups, db.groupExpenses, db.groupSettlements, async () => {
      await db.accounts.clear();
      await db.transactions.clear();
      await db.loans.clear();
      await db.emiSchedules.clear();
      await db.goals.clear();
      await db.activityLog.clear();
      await db.upcomingExpenses.clear();
      await db.splitGroups.clear();
      await db.groupExpenses.clear();
      await db.groupSettlements.clear();

      const d = parsed.data;
      if (d.accounts?.length) await db.accounts.bulkAdd(d.accounts);
      if (d.transactions?.length) await db.transactions.bulkAdd(d.transactions);
      if (d.loans?.length) await db.loans.bulkAdd(d.loans);
      if (d.emiSchedules?.length) await db.emiSchedules.bulkAdd(d.emiSchedules);
      if (d.goals?.length) await db.goals.bulkAdd(d.goals);
      if (d.activityLog?.length) await db.activityLog.bulkAdd(d.activityLog);
      if (d.upcomingExpenses?.length) await db.upcomingExpenses.bulkAdd(d.upcomingExpenses);
      if (d.splitGroups?.length) await db.splitGroups.bulkAdd(d.splitGroups);
      if (d.groupExpenses?.length) await db.groupExpenses.bulkAdd(d.groupExpenses);
      if (d.groupSettlements?.length) await db.groupSettlements.bulkAdd(d.groupSettlements);
    });

    // Restore settings
    if (parsed.settings) {
      Object.entries(parsed.settings).forEach(([k, v]) => {
        if (v !== null && v !== undefined) localStorage.setItem(k, v as string);
      });
    }

    return { success: true, message: 'Data restored successfully' };
  } catch (e) {
    return { success: false, message: e instanceof Error ? e.message : 'Import failed' };
  }
}

export function downloadJSON(data: string, filename: string) {
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
