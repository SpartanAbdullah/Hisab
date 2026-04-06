import { create } from 'zustand';

export type Language = 'ur' | 'en';

const S = {
  // Bottom Nav
  nav_home: { ur: 'Home', en: 'Home' },
  nav_transactions: { ur: 'Lenden', en: 'Transactions' },
  nav_loans: { ur: 'Qarz', en: 'Loans' },
  nav_goals: { ur: 'Bachat', en: 'Savings' },
  nav_activity: { ur: 'Kaam', en: 'Activity' },

  // Transaction type labels
  tx_income: { ur: 'Amdani', en: 'Income' },
  tx_expense: { ur: 'Kharcha', en: 'Expense' },
  tx_transfer: { ur: 'Move', en: 'Move' },
  tx_loan_given: { ur: 'Diya', en: 'Lent' },
  tx_loan_taken: { ur: 'Liya', en: 'Borrowed' },
  tx_repayment: { ur: 'Wapsi', en: 'Repayment' },
  tx_goal_contribution: { ur: 'Bachat', en: 'Savings' },
  tx_opening_balance: { ur: 'Opening Balance', en: 'Opening Balance' },

  // Transaction type sub-labels
  tx_income_sub: { ur: 'Money in', en: 'Money in' },
  tx_expense_sub: { ur: 'Money out', en: 'Money out' },
  tx_transfer_sub: { ur: 'Move money', en: 'Move money' },
  tx_loan_given_sub: { ur: 'Lent money', en: 'Lent money' },
  tx_loan_taken_sub: { ur: 'Borrowed', en: 'Borrowed' },
  tx_repayment_sub: { ur: 'Pay back', en: 'Pay back' },
  tx_goal_contribution_sub: { ur: 'Save up', en: 'Save up' },

  // Quick Entry
  quick_how_much: { ur: 'Kitna Paisa?', en: 'How Much?' },
  quick_what_type: { ur: 'Kis Tarah Ka?', en: 'What Type?' },
  quick_details: { ur: 'Details Bharein', en: 'Fill Details' },
  quick_enter_amount: { ur: 'Amount daalo — baaki hum poochenge', en: "Enter amount — we'll ask the rest" },
  quick_next: { ur: 'Aagay', en: 'Next' },
  quick_create_first: { ur: 'Pehle Account Banao', en: 'Create Account First' },
  quick_change_amount: { ur: 'Amount Badlo', en: 'Change Amount' },
  quick_from: { ur: 'Kahan Se?', en: 'From Where?' },
  quick_to: { ur: 'Kahan?', en: 'Where To?' },
  quick_who: { ur: 'Kisko?', en: 'To Whom?' },
  quick_who_placeholder: { ur: 'Naam likho — e.g. Ahmed Bhai', en: 'Enter name — e.g. Ahmed' },
  quick_which_loan: { ur: 'Kaun Sa Qarz?', en: 'Which Loan?' },
  quick_money_where: { ur: 'Paisa Kahan Aayega?', en: 'Money Goes Where?' },
  quick_pay_from: { ur: 'Kahan Se Doge?', en: 'Pay From?' },
  quick_which_goal: { ur: 'Kaun Sa Goal?', en: 'Which Goal?' },
  quick_note: { ur: 'Note (Optional)', en: 'Note (Optional)' },
  quick_save: { ur: 'Save Karo', en: 'Save' },
  quick_processing: { ur: 'Processing...', en: 'Processing...' },
  quick_where_money: { ur: 'Ye paisa kahan gaya?', en: 'Where did this money go?' },

  // Conversion
  conv_title: { ur: 'Currency Conversion', en: 'Currency Conversion' },
  conv_moving: { ur: 'Aap bhej rahe hain', en: 'You are moving' },
  conv_rate: { ur: 'Aaj ka rate daalo: 1', en: "Enter today's rate: 1" },
  conv_will_get: { ur: 'Milenge', en: 'Will receive' },

  // Account Stepper
  acct_what_type: { ur: 'Kaisa Account?', en: 'Account Type?' },
  acct_details: { ur: 'Details', en: 'Details' },
  acct_opening: { ur: 'Opening Balance', en: 'Opening Balance' },
  acct_create_first: { ur: 'Pehle Account Banao', en: 'Create Account First' },
  acct_need_for_tx: { ur: 'Transaction ke liye pehle ek account chahiye', en: 'You need an account first' },
  acct_quick_select: { ur: 'Jaldi Select Karo', en: 'Quick Select' },
  acct_or_type: { ur: 'Ya Khud Likho', en: 'Or Type Manually' },
  acct_name: { ur: 'Account Ka Naam', en: 'Account Name' },
  acct_how_much: { ur: 'Abhi Kitna Paisa Hai?', en: 'Current Balance?' },
  acct_leave_empty: { ur: 'Khali chhor do agar pata nahi', en: 'Leave empty if unknown' },
  acct_creating: { ur: 'Bana Rahe Hain...', en: 'Creating...' },
  acct_create: { ur: 'Account Banao', en: 'Create Account' },
  acct_created: { ur: 'Account Ban Gaya!', en: 'Account Created!' },
  acct_deleted: { ur: 'Account Delete Ho Gaya!', en: 'Account Deleted!' },
  acct_delete_confirm: { ur: 'Kya aap ye account delete karna chahte hain?', en: 'Are you sure you want to delete this account?' },
  acct_delete_nonzero: { ur: 'Delete Nahi Ho Sakta', en: 'Cannot Delete' },
  acct_delete_nonzero_desc: { ur: 'Pehle balance zero karo, phir delete hoga', en: 'Account must have zero balance before deletion' },
  acct_new: { ur: 'Naya Account', en: 'New Account' },

  // Account types
  type_cash: { ur: 'Cash / Naqdee', en: 'Cash' },
  type_bank: { ur: 'Bank Account', en: 'Bank Account' },
  type_wallet: { ur: 'Digital Wallet', en: 'Digital Wallet' },
  type_savings: { ur: 'Savings / Bachat', en: 'Savings' },
  type_credit_card: { ur: 'Credit Card', en: 'Credit Card' },

  // Credit Card
  cc_issuer: { ur: 'Bank / Issuer', en: 'Issuer Bank' },
  cc_last4: { ur: 'Last 4 Digits', en: 'Last 4 Digits' },
  cc_limit: { ur: 'Credit Limit', en: 'Credit Limit' },
  cc_due_day: { ur: 'Due Date (Day of Month)', en: 'Due Date (Day of Month)' },
  cc_available: { ur: 'Available', en: 'Available' },
  cc_used: { ur: 'Used', en: 'Used' },
  cc_next_due: { ur: 'Next Payment', en: 'Next Payment' },

  // Loan
  loan_new: { ur: 'Naya Qarz', en: 'New Loan' },
  loan_i_gave: { ur: 'Maine Diya', en: 'I Lent' },
  loan_i_took: { ur: 'Maine Liya', en: 'I Borrowed' },
  loan_to_whom: { ur: 'Kisko / Kisse?', en: 'To/From Whom?' },
  loan_paid_from: { ur: 'Kahan Se Diya?', en: 'Paid From?' },
  loan_received_into: { ur: 'Kahan Aaya?', en: 'Received Into?' },
  loan_set_emi: { ur: 'EMI schedule set karo', en: 'Set EMI Schedule' },
  loan_installments: { ur: 'Qistein', en: 'Installments' },
  loan_create: { ur: 'Qarz Banao', en: 'Create Loan' },
  loan_creating: { ur: 'Bana Rahe Hain...', en: 'Creating...' },
  loan_not_found: { ur: 'Loan nahi mila', en: 'Loan not found' },
  loan_gave: { ur: 'Aapne Diya', en: 'You Lent' },
  loan_took: { ur: 'Aapne Liya', en: 'You Borrowed' },
  loan_returned: { ur: 'Wapas', en: 'Returned' },
  loan_remaining: { ur: 'Baqi', en: 'Remaining' },
  loan_completed: { ur: 'Mukammal', en: 'Completed' },
  loan_repay: { ur: 'Wapsi', en: 'Repay' },
  loan_mark_paid: { ur: 'Paid Mark Karo', en: 'Mark as Paid' },
  loan_installment_amount: { ur: 'Qist Amount', en: 'Installment Amount' },
  loan_no_tx: { ur: 'Abhi koi transaction nahi', en: 'No transactions yet' },
  loan_receivable: { ur: 'Wapsi Aani Hai', en: 'To Receive' },
  loan_payable: { ur: 'Dena Hai', en: 'To Pay' },
  loan_people_owe: { ur: 'Logon Ne Dene Hain', en: 'People Owe You' },
  loan_you_owe: { ur: 'Aapne Dena Hai', en: 'You Owe' },
  loan_tab_active: { ur: 'Chalu', en: 'Active' },
  loan_tab_settled: { ur: 'Khatam', en: 'Settled' },
  loan_none_active: { ur: 'Koi Qarz Nahi', en: 'No Loans' },
  loan_none_settled: { ur: 'Koi Settled Nahi', en: 'None Settled' },
  loan_desc_active: { ur: 'Jab kisi ko paisa dein ya lein, yahan dikhega', en: 'Loans will appear here' },
  loan_desc_settled: { ur: 'Jab koi qarz settle hoga, yahan aayega', en: 'Settled loans will appear here' },

  // Repayment modal
  repay_title: { ur: 'Wapsi Karo', en: 'Make Repayment' },
  repay_amount: { ur: 'Kitna Dena Hai?', en: 'How Much?' },
  repay_confirm: { ur: 'Wapsi Karo', en: 'Make Payment' },
  repay_paying: { ur: 'Processing...', en: 'Processing...' },
  repay_pay_from: { ur: 'Kahan Se Doge?', en: 'Pay From?' },
  repay_receive_in: { ur: 'Paisa Kahan Aayega?', en: 'Receive Into?' },

  // Goal
  goal_new: { ur: 'Naya Bachat Goal', en: 'New Savings Goal' },
  goal_name: { ur: 'Goal Ka Naam', en: 'Goal Name' },
  goal_linked: { ur: 'Linked Account', en: 'Linked Account' },
  goal_no_link: { ur: 'Internally Track Karo', en: 'Track Internally' },
  goal_no_link_desc: { ur: 'Goal ke andar paisa track hoga', en: 'Money tracked inside the goal' },
  goal_has_account: { ur: 'Kya alag savings account hai?', en: 'Link to a savings account?' },
  goal_create: { ur: 'Goal Banao', en: 'Create Goal' },
  goal_creating: { ur: 'Bana Rahe Hain...', en: 'Creating...' },
  goal_none: { ur: 'Koi Goal Nahi', en: 'No Goals' },
  goal_set_target: { ur: 'Apni bachat ka target set karo', en: 'Set your savings target' },
  goal_contribute: { ur: '+ Paisa Dalo', en: '+ Add Money' },
  goal_saved: { ur: 'Saved', en: 'Saved' },
  goal_target: { ur: 'Target', en: 'Target' },
  goal_internal: { ur: 'Goal mein track ho raha hai', en: 'Tracked within goal' },
  goal_done: { ur: 'Done!', en: 'Done!' },

  // Activity
  activity_title: { ur: 'Activity / Kaam', en: 'Activity' },
  activity_none: { ur: 'Koi Activity Nahi', en: 'No Activity' },
  activity_none_desc: { ur: 'Jab aap koi transaction karenge, yahan dikhegi', en: 'Your activity will appear here' },
  activity_today: { ur: 'Aaj', en: 'Today' },
  activity_yesterday: { ur: 'Kal', en: 'Yesterday' },

  // Home
  home_accounts: { ur: 'Accounts', en: 'Accounts' },
  home_recent: { ur: 'Recent', en: 'Recent' },
  home_see_all: { ur: 'Sab Dekho', en: 'See All' },
  home_no_accounts: { ur: 'Koi Account Nahi', en: 'No Accounts' },
  home_no_accounts_desc: { ur: 'Pehle apna account banao — cash, bank, ya wallet', en: 'Create your first account' },
  home_create_account: { ur: 'Account Banao', en: 'Create Account' },

  // Transaction page
  txpage_title: { ur: 'Transactions', en: 'Transactions' },
  txpage_all: { ur: 'Sab', en: 'All' },
  txpage_loans: { ur: 'Qarz', en: 'Loans' },
  txpage_none: { ur: 'Koi Transaction Nahi', en: 'No Transactions' },
  txpage_none_desc: { ur: 'Apni pehli transaction add karo', en: 'Add your first transaction' },
  txpage_add: { ur: 'Transaction Daalo', en: 'Add Transaction' },

  // Common
  fill_all: { ur: 'Sab fields bharo', en: 'Please fill all fields' },
  done_btn: { ur: 'Theek Hai — Done!', en: 'OK — Done!' },
  error: { ur: 'Error', en: 'Error' },
  naya: { ur: 'Naya', en: 'New' },
  category: { ur: 'Category', en: 'Category' },
  balance_changes: { ur: 'Paisa Kahan Gaya', en: 'Balance Changes' },
  updated: { ur: 'Updated', en: 'Updated' },
  tx_history: { ur: 'Transaction History', en: 'Transaction History' },
  no_tx: { ur: 'Koi Transaction Nahi', en: 'No Transactions' },
  no_tx_desc: { ur: 'Is account mein abhi koi transaction nahi hui', en: 'No transactions in this account yet' },

  // Validation
  insufficient_prefix: { ur: '', en: '' },
  insufficient_only: { ur: 'mein sirf', en: 'only has' },
  insufficient_suffix: { ur: 'hain. Itne pesay nahi hain.', en: 'available. Insufficient funds.' },

  // Settings / Language
  settings_language: { ur: 'Zuban', en: 'Language' },
  lang_ur: { ur: 'Roman Urdu', en: 'Roman Urdu' },
  lang_en: { ur: 'English', en: 'English' },

  // Loans page title
  loans_title: { ur: 'Qarz / Loans', en: 'Loans' },
  goals_title: { ur: 'Goals / Bachat', en: 'Savings Goals' },

  // Time filters
  time_today: { ur: 'Aaj', en: 'Today' },
  time_yesterday: { ur: 'Kal', en: 'Yesterday' },
  time_this_week: { ur: 'Is Hafta', en: 'This Week' },
  time_last_week: { ur: 'Pichla Hafta', en: 'Last Week' },
  time_this_month: { ur: 'Is Mahina', en: 'This Month' },
  time_last_month: { ur: 'Pichla Mahina', en: 'Last Month' },
  time_this_year: { ur: 'Is Saal', en: 'This Year' },
  time_last_year: { ur: 'Pichla Saal', en: 'Last Year' },
  time_all: { ur: 'Sab', en: 'All' },
  time_results: { ur: 'natije', en: 'results' },

  // Upcoming expenses
  upcoming_title: { ur: 'Aanay Walay Kharche', en: 'Upcoming Expenses' },
  upcoming_none: { ur: 'Koi Upcoming Kharcha Nahi', en: 'No Upcoming Expenses' },
  upcoming_none_desc: { ur: 'Apne aanay walay bills aur kharche yahan track karo', en: 'Track your upcoming bills and expenses here' },
  upcoming_add: { ur: 'Kharcha Add Karo', en: 'Add Expense' },
  upcoming_new: { ur: 'Naya Upcoming Kharcha', en: 'New Upcoming Expense' },
  upcoming_name: { ur: 'Kharche Ka Naam', en: 'Expense Name' },
  upcoming_amount: { ur: 'Kitna?', en: 'How Much?' },
  upcoming_due: { ur: 'Kab Dena Hai?', en: 'Due Date?' },
  upcoming_account: { ur: 'Kahan Se Jayega?', en: 'From Which Account?' },
  upcoming_creating: { ur: 'Bana Rahe Hain...', en: 'Creating...' },
  upcoming_create: { ur: 'Kharcha Banao', en: 'Create Expense' },
  upcoming_due_in: { ur: 'din baaqi', en: 'days left' },
  upcoming_overdue: { ur: 'Overdue!', en: 'Overdue!' },
  upcoming_due_today: { ur: 'Aaj Dena Hai!', en: 'Due Today!' },
  upcoming_mark_paid: { ur: 'Paid Mark Karo', en: 'Mark Paid' },
  upcoming_warning: { ur: 'Kharche Ka Warning', en: 'Expense Warning' },
  upcoming_low_balance: { ur: 'Balance Kam Hai', en: 'Low Balance' },

  // FAB menu
  fab_add_goal: { ur: 'Goal Banao', en: 'Add Goal' },
  fab_add_expense: { ur: 'Upcoming Kharcha', en: 'Upcoming Expense' },
  fab_add_loan: { ur: 'Naya Qarz', en: 'New Loan' },

  // Dashboard upcoming widget
  home_upcoming: { ur: 'Aanay Walay Kharche', en: 'Upcoming Expenses' },
  home_see_all_upcoming: { ur: 'Dekho Sab', en: 'See All' },

  // Spending warning
  spend_warning_title: { ur: 'Yaad Rakhein!', en: 'Remember!' },
  spend_warning_msg_prefix: { ur: '', en: '' },
  spend_warning_msg_suffix: { ur: 'ke liye chahiye hoga', en: 'will be needed for' },
  spend_warning_continue: { ur: 'Haan, Jaari Rakho', en: 'Yes, Continue' },
  spend_warning_cancel: { ur: 'Ruko, Baad Mein', en: 'Wait, Later' },

  // Upcoming statuses
  upcoming_status_done: { ur: 'Ho Gaya', en: 'Done' },
  upcoming_status_cancel: { ur: 'Cancel', en: 'Cancel' },
  // Smart insights
  insight_month_spent: { ur: 'Is mahine aapne {amount} kharcha kiya', en: 'You spent {amount} this month' },
  insight_no_upcoming: { ur: 'Koi upcoming kharcha nahi agle 7 dino mein', en: 'No upcoming expenses in next 7 days' },

  // Account card stats
  acct_stat_month: { ur: 'Is mahine', en: 'This month' },

  // Empty state improvements
  empty_loans_title: { ur: 'Koi qarz nahi', en: 'No loans' },
  empty_loans_desc: { ur: 'Kisi ko diya ya liya hua qarz yahan track karein', en: 'Track loans given or taken here' },
  empty_loans_cta: { ur: 'Qarz Add Karein', en: 'Add Loan' },
  empty_goals_title: { ur: 'Koi saving goal nahi', en: 'No saving goals' },
  empty_goals_desc: { ur: 'Apna pehla saving target set karein', en: 'Set your first savings target' },
  empty_goals_cta: { ur: 'Goal Banayein', en: 'Create Goal' },
  empty_activity_title: { ur: 'Koi activity nahi', en: 'No activity' },
  empty_activity_desc: { ur: 'Transactions karne ke baad sab kuch yahan nazar aayega', en: 'Activity will appear after transactions' },
  empty_tx_title: { ur: 'Koi transaction nahi', en: 'No transactions' },
  empty_tx_desc: { ur: 'Aaj ka pehla kharcha ya aamdani yahan add karein', en: 'Add your first expense or income here' },
  empty_tx_cta: { ur: 'Transaction Add Karein', en: 'Add Transaction' },

  // Empty dashboard guidance
  empty_dash_title: { ur: 'Sab set hai!', en: 'All set!' },
  empty_dash_desc: { ur: 'Ab apna pehla kharcha ya aamdani add karein neeche + button se', en: 'Add your first expense or income using the + button below' },
  empty_dash_tap: { ur: 'Neeche + dabayein', en: 'Tap + below' },

  // First account celebration
  first_acct_congrats: { ur: 'Mubarakbaad!', en: 'Congratulations!' },
  first_acct_msg: { ur: 'Aapka pehla account ban gaya. Ab hisaab rakhna shuru karein!', en: 'Your first account is ready. Start tracking now!' },

  // ── Mode Selection ──
  mode_select_title: { ur: 'Aapko Kya Chahiye?', en: 'What Do You Need?' },
  mode_select_sub: { ur: 'Baad mein Settings se badal sakte hain', en: 'You can change this later in Settings' },
  mode_splits_title: { ur: 'Sirf Kharche aur Splits', en: 'Expense & Splits Only' },
  mode_splits_sub: { ur: 'Splitwise jaisa — dosto ke saath hisaab', en: 'Like Splitwise — split with friends' },
  mode_splits_1: { ur: 'Group mein kharche share karo', en: 'Split expenses in groups' },
  mode_splits_2: { ur: 'Kaun kitna dena hai — ek nazar mein', en: 'See who owes whom at a glance' },
  mode_splits_3: { ur: 'Personal kharche bhi track karo', en: 'Track personal expenses too' },
  mode_full_title: { ur: 'Poora Hisaab Kitaab', en: 'Full Money Tracker' },
  mode_full_sub: { ur: 'Accounts, qarz, goals, splits — sab kuch', en: 'Accounts, loans, goals, splits — everything' },
  mode_full_1: { ur: 'Bank, cash, credit card accounts', en: 'Bank, cash, credit card accounts' },
  mode_full_2: { ur: 'Qarz aur EMI tracking', en: 'Loan & EMI tracking' },
  mode_full_3: { ur: 'Savings goals + group splits', en: 'Savings goals + group splits' },

  mode_switch_blocked: { ur: 'Switch Nahi Ho Sakta', en: 'Cannot Switch Mode' },
  mode_switch_blocked_desc: { ur: 'Pehle sab accounts ka balance zero karo', en: 'All accounts must have zero balance first' },

  // ── Groups / Splits ──
  nav_groups: { ur: 'Groups', en: 'Groups' },
  groups_title: { ur: 'Groups', en: 'Groups' },
  group_new: { ur: 'Naya Group Banao', en: 'Create Group' },
  group_name: { ur: 'Group Ka Naam', en: 'Group Name' },
  group_name_placeholder: { ur: 'e.g. Dubai Trip Boys', en: 'e.g. Dubai Trip Boys' },
  group_emoji: { ur: 'Emoji Chuno', en: 'Pick Emoji' },
  group_members: { ur: 'Members', en: 'Members' },
  group_add_member: { ur: 'Member Add Karo', en: 'Add Member' },
  group_member_name: { ur: 'Naam', en: 'Name' },
  group_create: { ur: 'Group Banao', en: 'Create Group' },
  group_creating: { ur: 'Bana Rahe Hain...', en: 'Creating...' },
  group_created: { ur: 'Group Ban Gaya!', en: 'Group Created!' },
  group_you_owed: { ur: 'Aapko milna hai', en: 'You are owed' },
  group_you_owe: { ur: 'Aapne dena hai', en: 'You owe' },
  group_settled: { ur: 'Sab barabar', en: 'All settled' },
  group_members_count: { ur: 'members', en: 'members' },
  group_empty: { ur: 'Koi group nahi', en: 'No groups yet' },
  group_empty_desc: { ur: 'Dosto ke saath kharche share karne ke liye group banao', en: 'Create a group to split expenses with friends' },
  group_expense_add: { ur: 'Kharcha Daalo', en: 'Add Expense' },
  group_settle: { ur: 'Settlement Karo', en: 'Settle Up' },
  group_expenses: { ur: 'Kharche', en: 'Expenses' },
  group_balances: { ur: 'Balances', en: 'Balances' },
  group_no_expenses: { ur: 'Abhi koi kharcha nahi', en: 'No expenses yet' },
  group_paid_by: { ur: 'Kisne Diya?', en: 'Paid By?' },
  group_split_between: { ur: 'Kin Mein Banta?', en: 'Split Between?' },
  group_split_type: { ur: 'Kaise Bantay?', en: 'Split Type?' },
  group_split_equal: { ur: 'Barabar', en: 'Equal' },
  group_split_exact: { ur: 'Exact Amount', en: 'Exact' },
  group_split_pct: { ur: 'Percentage', en: 'Percentage' },
  group_split_shares: { ur: 'Shares', en: 'Shares' },
  group_each_pays: { ur: 'Har ek dega', en: 'Each pays' },
  group_total_mismatch: { ur: 'Total match nahi kar raha', en: 'Total does not match' },
  group_pct_mismatch: { ur: 'Total 100% hona chahiye', en: 'Must total 100%' },
  group_desc: { ur: 'Kis cheez ka?', en: 'What for?' },
  group_desc_placeholder: { ur: 'e.g. Dinner at Salt Bae', en: 'e.g. Dinner at Salt Bae' },
  group_amount: { ur: 'Kitna?', en: 'How much?' },
  group_save_expense: { ur: 'Kharcha Save Karo', en: 'Save Expense' },
  group_settle_title: { ur: 'Settlement', en: 'Settle Up' },
  group_settle_from: { ur: 'Kisne Diya?', en: 'Who Paid?' },
  group_settle_to: { ur: 'Kisko Diya?', en: 'Paid To?' },
  group_settle_amount: { ur: 'Kitna?', en: 'Amount?' },
  group_settle_note: { ur: 'Note', en: 'Note' },
  group_settle_save: { ur: 'Settlement Save Karo', en: 'Save Settlement' },
  group_owes: { ur: 'dena hai', en: 'owes' },
  group_to: { ur: 'ko', en: 'to' },
  group_delete: { ur: 'Group Delete Karo', en: 'Delete Group' },
  group_delete_confirm: { ur: 'Kya aap yeh group delete karna chahte hain?', en: 'Are you sure you want to delete this group?' },

  // ── Analytics ──
  nav_analytics: { ur: 'Report', en: 'Analytics' },
  analytics_title: { ur: 'Analytics', en: 'Analytics' },
  analytics_banner_desc: { ur: 'Kharche aur aamdani ka mukammal jaiza', en: 'View your spending & income insights' },
  analytics_spending: { ur: 'Kharche Ka Hisaab', en: 'Spending Overview' },
  analytics_categories: { ur: 'Category Wise', en: 'By Category' },
  analytics_trend: { ur: 'Monthly Trend', en: 'Monthly Trend' },
  analytics_daily: { ur: 'Daily Kharcha', en: 'Daily Spending' },
  analytics_top: { ur: 'Sab Se Bade Kharche', en: 'Top Expenses' },
  analytics_income_vs_expense: { ur: 'Aamdani vs Kharcha', en: 'Income vs Expense' },
  analytics_no_data: { ur: 'Abhi koi data nahi', en: 'No data yet' },
  analytics_this_month: { ur: 'Is Maheene', en: 'This Month' },
  analytics_last_month: { ur: 'Pichle Maheene', en: 'Last Month' },
  analytics_3months: { ur: 'Pichle 3 Maheene', en: 'Last 3 Months' },
  analytics_year: { ur: 'Poora Saal', en: 'Full Year' },
  analytics_total_spent: { ur: 'Total Kharcha', en: 'Total Spent' },
  analytics_total_income: { ur: 'Total Aamdani', en: 'Total Income' },
  analytics_group_spending: { ur: 'Group Kharche', en: 'Group Spending' },
  analytics_your_share: { ur: 'Aapka Hissa', en: 'Your Share' },

  // ── Settings ──
  nav_settings: { ur: 'Settings', en: 'Settings' },
  settings_title: { ur: 'Settings', en: 'Settings' },
  settings_app_mode: { ur: 'App Mode', en: 'App Mode' },
  settings_mode_current: { ur: 'Abhi', en: 'Current' },
  settings_switch_mode: { ur: 'Mode Badlo', en: 'Switch Mode' },
  settings_backup: { ur: 'Backup & Restore', en: 'Backup & Restore' },
  settings_export: { ur: 'Data Export Karo', en: 'Export Data' },
  settings_export_desc: { ur: 'Apna sara data JSON file mein download karo', en: 'Download all data as a JSON file' },
  settings_import: { ur: 'Data Import Karo', en: 'Import Data' },
  settings_import_desc: { ur: 'Pehle se backup ki hui file se data restore karo', en: 'Restore data from a backup file' },
  settings_import_warn: { ur: 'Yeh current data replace kar dega. Pehle backup le lein?', en: 'This will replace current data. Take a backup first?' },
  settings_import_success: { ur: 'Data restore ho gaya!', en: 'Data restored successfully!' },
  settings_import_fail: { ur: 'Import fail ho gaya', en: 'Import failed' },
  settings_security: { ur: 'Security', en: 'Security' },
  settings_set_pin: { ur: 'PIN Set Karo', en: 'Set PIN' },
  settings_change_pin: { ur: 'PIN Badlo', en: 'Change PIN' },
  settings_remove_pin: { ur: 'PIN Hatao', en: 'Remove PIN' },
  settings_pin_desc: { ur: 'Yeh PIN sirf is device ke liye hai', en: 'This PIN is for this device only' },
  settings_about: { ur: 'Hisaab v2.0', en: 'Hisaab v2.0' },
  settings_about_desc: { ur: 'Aapka paisa, aapki nazar mein', en: 'Your money, your way' },

  // ── PIN Lock ──
  pin_title: { ur: 'PIN Daalo', en: 'Enter PIN' },
  pin_subtitle: { ur: 'Apna 4-digit PIN daalo', en: 'Enter your 4-digit PIN' },
  pin_wrong: { ur: 'Ghalat PIN', en: 'Wrong PIN' },
  pin_locked: { ur: '30 second ruko', en: 'Wait 30 seconds' },
  pin_set_title: { ur: 'Naya PIN Set Karo', en: 'Set New PIN' },
  pin_confirm: { ur: 'PIN Dobara Daalo', en: 'Confirm PIN' },
  pin_mismatch: { ur: 'PIN match nahi kiya', en: 'PINs do not match' },
  pin_set_success: { ur: 'PIN set ho gaya!', en: 'PIN set successfully!' },
  pin_removed: { ur: 'PIN hata diya', en: 'PIN removed' },

  // ── Auth / Profile ──
  auth_skip: { ur: 'Baad Mein', en: 'Skip for now' },
  auth_banner: { ur: 'Apna account banao taake data safe rahe', en: 'Create an account to keep your data safe' },
  auth_identifier: { ur: 'Email ya Mobile Number', en: 'Email or Mobile Number' },

  // ── Onboarding extras ──
  onboard_step_of: { ur: 'ka', en: 'of' },
  onboard_tagline: { ur: 'Aapka paisa, aapki nazar mein.', en: 'Your money, always in sight.' },
  onboard_bullet_1: { ur: 'Har transaction track karein', en: 'Track every transaction' },
  onboard_bullet_2: { ur: 'Apne sab accounts ek jagah', en: 'All your accounts in one place' },
  onboard_bullet_3: { ur: 'Saving goals aur qarz manage karein', en: 'Manage savings goals & loans' },
  onboard_start: { ur: 'Shuru Karein', en: 'Get Started' },
  onboard_footer: { ur: 'No signup. No internet. Sab phone mein.', en: 'No signup. No internet. Everything on your phone.' },
  onboard_your_name: { ur: 'Apna naam batayein', en: 'What\'s your name?' },
  onboard_name_sub: { ur: 'Hum aapko naam se bulayenge', en: 'We\'ll greet you by name' },
  onboard_name_label: { ur: 'Aapka Naam', en: 'Your Name' },
  onboard_currency_label: { ur: 'Primary Currency', en: 'Primary Currency' },
  onboard_next: { ur: 'Aagay Chalein', en: 'Continue' },
  onboard_safety_title: { ur: 'Aapka Data Sirf Aapka Hai', en: 'Your Data Belongs Only to You' },
  onboard_safety_sub: { ur: 'Your Data Belongs Only to You', en: 'Complete privacy, zero cloud uploads' },
  onboard_safety_1: { ur: 'Hisaab sirf aapke phone/browser mein save hota hai', en: 'Hisaab saves data only in your phone/browser' },
  onboard_safety_1_sub: { ur: 'Data only on your device', en: 'Data only on your device' },
  onboard_safety_2: { ur: 'Koi server nahi, koi cloud nahi', en: 'No server, no cloud upload' },
  onboard_safety_2_sub: { ur: 'No server, no cloud upload', en: 'No server, no cloud upload' },
  onboard_safety_3: { ur: 'Full account number kabhi mat daalein — sirf last 4 digits kaafi hain', en: 'Never enter full account number — last 4 digits are enough' },
  onboard_safety_3_sub: { ur: 'Never enter full account number', en: 'Never enter full account number' },
  onboard_safety_4: { ur: 'Koi card ka CVV, expiry ya PIN mat daalein', en: 'Never enter CVV, expiry or card PIN' },
  onboard_safety_4_sub: { ur: 'Never enter CVV, expiry or PIN', en: 'Never enter CVV, expiry or PIN' },
  onboard_safety_5: { ur: 'Yeh app sirf representation hai — asli bank ki jagah nahi', en: 'This app is a representation — not a bank replacement' },
  onboard_safety_5_sub: { ur: 'Not a replacement for your real bank', en: 'Not a replacement for your real bank' },
  onboard_safety_btn: { ur: 'Samajh Gaya, Aage Chalein', en: 'Got it, Continue' },
  onboard_safety_footer: { ur: 'Yeh message dobara nahi aayega', en: 'This message won\'t appear again' },
  onboard_how_start: { ur: 'kaise shuru karein?', en: 'how should we begin?' },
  onboard_how_sub: { ur: 'Aap baad mein sab change kar sakte hain', en: 'You can change everything later' },
  onboard_demo_title: { ur: 'Demo Data se Dekho', en: 'Try with Demo Data' },
  onboard_demo_sub: { ur: 'Pehle samjho, phir apna daalo', en: 'Explore first, add yours later' },
  onboard_demo_desc: { ur: 'Accounts, transactions, loans — sab tayar milega.', en: 'Accounts, transactions, loans — all preloaded.' },
  onboard_fresh_title: { ur: 'Fresh Start Karo', en: 'Start Fresh' },
  onboard_fresh_sub: { ur: 'Khali slate, apna hisaab', en: 'Clean slate, your own records' },
  onboard_fresh_desc: { ur: 'Apne accounts khud banao aur shuru karo.', en: 'Create your accounts and start tracking.' },
  onboard_loading: { ur: 'Aapka Hisaab tayyar ho raha hai...', en: 'Setting up your Hisaab...' },
  onboard_back: { ur: '← Wapas Jayen', en: '← Go Back' },

  // ── Account Detail ──
  acct_add_opening_bal: { ur: 'Opening Balance Daalein', en: 'Add Opening Balance' },
  acct_opening_bal_prompt: { ur: 'Is account ka opening balance kitna hai?', en: 'What\'s the opening balance of this account?' },

  // ── Search ──
  search_placeholder: { ur: 'Kharcha dhoondo...', en: 'Search expenses...' },
  search_results: { ur: 'nateeje', en: 'results' },

  // ── My Account ──
  settings_my_account: { ur: 'Mera Account', en: 'My Account' },
  settings_my_account_desc: { ur: 'Profile aur security settings', en: 'Profile & security settings' },
  settings_email: { ur: 'Email', en: 'Email' },
  settings_mobile: { ur: 'Mobile Number', en: 'Mobile Number' },
  settings_password: { ur: 'Password', en: 'Password' },
  settings_reset_password: { ur: 'Password Reset Karo', en: 'Reset Password' },
  settings_save_profile: { ur: 'Profile Save Karo', en: 'Save Profile' },
  settings_profile_saved: { ur: 'Profile save ho gaya!', en: 'Profile saved!' },

  // ── Activity types ──
  activity_new: { ur: 'Naya Entry', en: 'New Entry' },
  activity_modified: { ur: 'Badla Gaya', en: 'Modified' },
  activity_deleted: { ur: 'Hataya Gaya', en: 'Deleted' },
  activity_settled: { ur: 'Settle Hua', en: 'Settled' },
  activity_transfer: { ur: 'Transfer', en: 'Transfer' },

  // PWA install
  pwa_install_title: { ur: 'Hisaab Install Karo', en: 'Install Hisaab' },
  pwa_install_cta: { ur: 'Install', en: 'Install' },
  pwa_install_native_sub: { ur: 'App ko home screen par add karo', en: 'Add the app to your home screen' },
  pwa_install_ios_sub: { ur: 'Safari se home screen par add karo', en: 'Add this app from Safari' },
  pwa_install_android_sub: { ur: 'Browser menu se app install karo', en: 'Install the app from your browser menu' },
  pwa_install_ios_steps: {
    ur: 'Safari mein Share dabao, phir Add to Home Screen select karo.',
    en: 'In Safari, tap Share, then choose Add to Home Screen.',
  },
  pwa_install_android_steps: {
    ur: 'Browser menu kholo, phir Install app ya Add to Home screen chuno.',
    en: 'Open the browser menu, then tap Install app or Add to Home screen.',
  },
} as const;

type Key = keyof typeof S;

interface I18nState {
  lang: Language;
  setLang: (lang: Language) => void;
}

export const useI18nStore = create<I18nState>((set) => ({
  lang: (localStorage.getItem('hisaab_lang') as Language) || 'ur',
  setLang: (lang) => {
    localStorage.setItem('hisaab_lang', lang);
    set({ lang });
  },
}));

export function useT() {
  const lang = useI18nStore((s) => s.lang);
  return (key: Key): string => {
    const entry = S[key];
    return entry ? entry[lang] : key;
  };
}
