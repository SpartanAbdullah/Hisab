import { create } from "zustand";

export type Language = "ur" | "en";

const S = {
  // Bottom Nav
  nav_home: { ur: "Home", en: "Home" },
  nav_transactions: { ur: "Lenden", en: "Transactions" },
  nav_loans: { ur: "Qarz", en: "Loans" },
  nav_goals: { ur: "Bachat", en: "Savings" },
  nav_activity: { ur: "Activity", en: "Activity" },

  // Transaction type labels
  tx_income: { ur: "Amdani", en: "Income" },
  tx_expense: { ur: "Kharcha", en: "Expense" },
  tx_transfer: { ur: "Move", en: "Move" },
  tx_loan_given: { ur: "Diya", en: "Lent" },
  tx_loan_taken: { ur: "Liya", en: "Borrowed" },
  tx_repayment: { ur: "Wapsi", en: "Repayment" },
  tx_goal_contribution: { ur: "Bachat", en: "Savings" },
  tx_opening_balance: { ur: "Opening Balance", en: "Opening Balance" },

  // Transaction type sub-labels
  tx_income_sub: { ur: "Money in", en: "Money in" },
  tx_expense_sub: { ur: "Money out", en: "Money out" },
  tx_transfer_sub: { ur: "Move money", en: "Move money" },
  tx_loan_given_sub: { ur: "Lent money", en: "Lent money" },
  tx_loan_taken_sub: { ur: "Borrowed", en: "Borrowed" },
  tx_repayment_sub: { ur: "Pay back", en: "Pay back" },
  tx_goal_contribution_sub: { ur: "Save up", en: "Save up" },

  // Quick Entry
  quick_how_much: { ur: "Kitnay Paisay?", en: "How Much?" },
  quick_what_type: { ur: "Kis Type Ka?", en: "What Type?" },
  quick_details: { ur: "Details Likhain", en: "Fill Details" },
  quick_enter_amount: {
    ur: "Amount daalo — baaki hum poochenge",
    en: "Enter amount — we'll ask the rest",
  },
  quick_next: { ur: "Aagay", en: "Next" },
  quick_create_first: { ur: "Pehle Account Banao", en: "Create Account First" },
  quick_change_amount: { ur: "Amount Badlo", en: "Change Amount" },
  quick_from: { ur: "Kis account say?", en: "From Where?" },
  quick_to: { ur: "Kis account main?", en: "Where To?" },
  quick_who: { ur: "Kisko?", en: "To Whom?" },
  quick_who_placeholder: {
    ur: "Naam likho — e.g. Ahmed Bhai",
    en: "Enter name — e.g. Ahmed",
  },
  quick_which_loan: { ur: "Kaun Sa Qarz?", en: "Which Loan?" },
  quick_money_where: {
    ur: "Paisa Kis account main Aayega?",
    en: "Money Goes Where?",
  },
  quick_pay_from: { ur: "Kahan Se Doge?", en: "Pay From?" },
  quick_which_goal: { ur: "Kaun Sa Goal?", en: "Which Goal?" },
  quick_note: { ur: "Note (Optional)", en: "Note (Optional)" },
  quick_save: { ur: "Save Karo", en: "Save" },
  quick_processing: { ur: "Processing...", en: "Processing..." },
  quick_where_money: {
    ur: "Ye paisa kahan gaya?",
    en: "Where did this money go?",
  },

  // Conversion
  conv_title: { ur: "Currency Conversion", en: "Currency Conversion" },
  conv_moving: { ur: "Aap bhej rahe hain", en: "You are moving" },
  conv_rate: { ur: "Aaj ka rate daalo: 1", en: "Enter today's rate: 1" },
  conv_will_get: { ur: "Milenge", en: "Will receive" },

  // Account Stepper
  acct_what_type: { ur: "Kis type ka Account?", en: "Account Type?" },
  acct_details: { ur: "Details", en: "Details" },
  acct_opening: { ur: "Opening Balance", en: "Opening Balance" },
  acct_create_first: { ur: "Pehle Account Banao", en: "Create Account First" },
  acct_need_for_tx: {
    ur: "Transaction ke liye pehle ek account chahiye",
    en: "You need an account first",
  },
  acct_quick_select: { ur: "Quick Select", en: "Quick Select" },
  acct_or_type: { ur: "Ya Khud Likho", en: "Or Type Manually" },
  acct_name: { ur: "Account Ka Naam", en: "Account Name" },
  acct_how_much: { ur: "Abhi Kitna Paisay Hain?", en: "Current Balance?" },
  acct_leave_empty: {
    ur: "Khali chhor do agar pata nahi",
    en: "Leave empty if unknown",
  },
  acct_creating: { ur: "Bana Rahe Hain...", en: "Creating..." },
  acct_create: { ur: "Account Banao", en: "Create Account" },
  acct_created: { ur: "Account Ban Gaya!", en: "Account Created!" },
  acct_deleted: { ur: "Account Delete Ho Gaya!", en: "Account Deleted!" },
  acct_delete_confirm: {
    ur: "Waqai? account delete Kar dain?",
    en: "Are you sure you want to delete this account?",
  },
  acct_delete_nonzero: {
    ur: "Uh Oh! Delete Nahi Ho Sakta",
    en: "Cannot Delete",
  },
  acct_delete_nonzero_desc: {
    ur: "Pehle balance zero karo, phir delete hoga",
    en: "Account must have zero balance before deletion",
  },
  acct_new: { ur: "Naya Account", en: "New Account" },

  // Account types
  type_cash: { ur: "Cash / Naqad", en: "Cash" },
  type_bank: { ur: "Bank Account", en: "Bank Account" },
  type_wallet: { ur: "Digital Wallet", en: "Digital Wallet" },
  type_savings: { ur: "Savings / Bachat", en: "Savings" },
  type_credit_card: { ur: "Credit Card", en: "Credit Card" },

  // Credit Card
  cc_issuer: { ur: "Bank / Issuer", en: "Issuer Bank" },
  cc_last4: { ur: "Last 4 Digits", en: "Last 4 Digits" },
  cc_limit: { ur: "Credit Limit", en: "Credit Limit" },
  cc_due_day: { ur: "Due Date (Day of Month)", en: "Due Date (Day of Month)" },
  cc_available: { ur: "Available", en: "Available" },
  cc_used: { ur: "Used", en: "Used" },
  cc_next_due: { ur: "Next Payment", en: "Next Payment" },

  // Loan
  loan_new: { ur: "Naya Qarz", en: "New Loan" },
  loan_i_gave: { ur: "Maine Diya", en: "I Lent" },
  loan_i_took: { ur: "Maine Liya", en: "I Borrowed" },
  loan_to_whom: { ur: "Kisko / Kisse?", en: "To/From Whom?" },
  loan_paid_from: { ur: "Kis account Se Diya?", en: "Paid From?" },
  loan_received_into: { ur: "Kis account main Aaya?", en: "Received Into?" },
  loan_set_emi: { ur: "EMI Set Karni hay?", en: "Set EMI Schedule?" },
  loan_installments: { ur: "Qistein", en: "Installments" },
  loan_create: { ur: "Qarz Banao", en: "Create Loan" },
  loan_creating: { ur: "Bana Rahe Hain...", en: "Creating..." },
  loan_not_found: { ur: "Loan nahi mila", en: "Loan not found" },
  loan_gave: { ur: "Aapne Diya", en: "You Lent" },
  loan_took: { ur: "Aapne Liya", en: "You Borrowed" },
  loan_returned: { ur: "Wapas", en: "Returned" },
  loan_remaining: { ur: "Baqi", en: "Remaining" },
  loan_completed: { ur: "Mukammal", en: "Completed" },
  loan_repay: { ur: "Wapsi", en: "Repay" },
  loan_mark_paid: { ur: "Paid Mark Karo", en: "Mark as Paid" },
  loan_installment_amount: { ur: "Qist Amount", en: "Installment Amount" },
  loan_no_tx: { ur: "Abhi koi transaction nahi", en: "No transactions yet" },
  loan_receivable: { ur: "Wapsi Aani Hai", en: "To Receive" },
  loan_payable: { ur: "Dena Hai", en: "To Pay" },
  loan_people_owe: { ur: "Logon Ne Dene Hain", en: "People Owe You" },
  loan_you_owe: { ur: "Aapne Dena Hai", en: "You Owe" },
  loan_tab_active: { ur: "Chalu", en: "Active" },
  loan_tab_settled: { ur: "Khatam", en: "Settled" },
  loan_none_active: { ur: "Koi Qarz Nahi", en: "No Loans" },
  loan_none_settled: { ur: "Koi Settled Nahi", en: "None Settled" },
  loan_desc_active: {
    ur: "Jab kisi ko paisa dein ya lein, yahan dikhega",
    en: "Loans will appear here",
  },
  loan_desc_settled: {
    ur: "Jab koi qarz settle hoga, yahan aayega",
    en: "Settled loans will appear here",
  },
  money_not_moved_notice: {
    ur: "Yeh action asal paisay transfer nahi karta. Barah-e-karam apne account check karein.",
    en: "This action does not move real money. Please check your accounts for actual transfer.",
  },

  // Soft payment reminders
  reminder_title: { ur: "Reminder Message", en: "Reminder Message" },
  reminder_cta: { ur: "Remind", en: "Remind" },
  reminder_copy: { ur: "Copy", en: "Copy" },
  reminder_share: { ur: "Share", en: "Share" },
  reminder_copied: { ur: "Reminder copied", en: "Reminder copied" },
  reminder_copy_failed: { ur: "Copy nahi ho saka", en: "Could not copy" },
  reminder_share_failed: { ur: "Share nahi ho saka", en: "Could not share" },
  reminder_tone: { ur: "Tone", en: "Tone" },
  reminder_tone_friendly: { ur: "Friendly", en: "Friendly" },
  reminder_tone_neutral: { ur: "Neutral", en: "Neutral" },
  reminder_tone_formal: { ur: "Ghussay Wala", en: "Formal" },
  reminder_preview: { ur: "Preview", en: "Preview" },
  reminder_they_owe_me: { ur: "Unho nay Meray denay hain", en: "They owe me" },
  reminder_i_owe_them: { ur: "Menay unkay denay hain", en: "I owe them" },
  reminder_manual_only: {
    ur: "Ye message auto-send nahi hota. Copy ya share karke manually bhejein.",
    en: "This will not auto-send. Copy or share it manually.",
  },
  reminder_no_due_date: { ur: "No exact due date", en: "No exact due date" },
  reminder_open_today: { ur: "opened today", en: "opened today" },
  reminder_open_days: {
    ur: "open for {count} days",
    en: "open for {count} days",
  },
  reminder_overdue_days: {
    ur: "{count} days overdue",
    en: "{count} days overdue",
  },
  reminder_duration_fallback: { ur: "earlier", en: "earlier" },
  reminder_duration_today: { ur: "Aaj", en: "today" },
  reminder_duration_yesterday: { ur: "1 din pehlay", en: "1 day ago" },
  reminder_duration_days: { ur: "{count} din pehlay", en: "{count} days ago" },
  reminder_duration_month: { ur: "1 month ago", en: "1 month ago" },
  reminder_duration_months: {
    ur: "{count} months ago",
    en: "{count} months ago",
  },
  reminder_receivable_friendly: {
    ur: "Hey {name} \u{1F44B}\nJust a quick reminder about the {amount} from {duration}.\nLet me know when it's convenient for you \u{1F44D}",
    en: "Hey {name} \u{1F44B}\nJust a quick reminder about the {amount} from {duration}.\nLet me know when it's convenient for you \u{1F44D}",
  },
  reminder_receivable_neutral: {
    ur: "Hi {name}, this is a reminder that {amount} is still pending from {duration}. Please update me when possible.",
    en: "Hi {name}, this is a reminder that {amount} is still pending from {duration}. Please update me when possible.",
  },
  reminder_receivable_formal: {
    ur: "Dear {name}, this is a polite reminder regarding the pending amount of {amount}, overdue since {duration}. Kindly arrange repayment when convenient.",
    en: "Dear {name}, this is a polite reminder regarding the pending amount of {amount}, overdue since {duration}. Kindly arrange repayment when convenient.",
  },
  reminder_payable_friendly: {
    ur: "Hey {name} \u{1F44B}\nJust noting that I still have {amount} pending to pay you from {duration}. I'll update you once it's cleared.",
    en: "Hey {name} \u{1F44B}\nJust noting that I still have {amount} pending to pay you from {duration}. I'll update you once it's cleared.",
  },
  reminder_payable_neutral: {
    ur: "Hi {name}, I have {amount} pending to pay you from {duration}. I'll update you once payment is made.",
    en: "Hi {name}, I have {amount} pending to pay you from {duration}. I'll update you once payment is made.",
  },
  reminder_payable_formal: {
    ur: "Dear {name}, this is to acknowledge that {amount} remains payable from my side from {duration}. I will update you once it is settled.",
    en: "Dear {name}, this is to acknowledge that {amount} remains payable from my side from {duration}. I will update you once it is settled.",
  },

  // Repayment modal
  repay_title: { ur: "Wapsi Karo", en: "Make Repayment" },
  repay_amount: { ur: "Kitnay day rahy ho?", en: "How Much?" },
  repay_confirm: { ur: "Wapsi Karo", en: "Make Payment" },
  repay_paying: { ur: "Processing...", en: "Processing..." },
  repay_pay_from: { ur: "Kon say account Se Doge?", en: "Pay From?" },
  repay_receive_in: {
    ur: "Paisa Kis account main Aayega?",
    en: "Receive Into?",
  },

  // Goal
  goal_new: { ur: "Naya Bachat Goal", en: "New Savings Goal" },
  goal_name: { ur: "Goal Ka Naam", en: "Goal Name" },
  goal_linked: { ur: "Linked Account", en: "Linked Account" },
  goal_no_link: { ur: "Internally Track Karo", en: "Track Internally" },
  goal_no_link_desc: {
    ur: "Goal ke andar paisa track hoga",
    en: "Money tracked inside the goal",
  },
  goal_has_account: {
    ur: "Kya alag savings account hai?",
    en: "Link to a savings account?",
  },
  goal_create: { ur: "Goal Banao", en: "Create Goal" },
  goal_creating: { ur: "Bana Rahe Hain...", en: "Creating..." },
  goal_none: { ur: "Koi Goal Nahi", en: "No Goals" },
  goal_set_target: {
    ur: "Apni bachat ka target set karo",
    en: "Set your savings target",
  },
  goal_contribute: { ur: "+ Paisa Dalo", en: "+ Add Money" },
  goal_saved: { ur: "Saved", en: "Saved" },
  goal_target: { ur: "Target", en: "Target" },
  goal_internal: {
    ur: "Goal mein track ho raha hai",
    en: "Tracked within goal",
  },
  goal_done: { ur: "Done!", en: "Done!" },

  // Activity
  activity_title: { ur: "Activity / Kaam", en: "Activity" },
  activity_none: { ur: "Koi Activity Nahi", en: "No Activity" },
  activity_none_desc: {
    ur: "Jab aap koi transaction karenge, yahan dikhegi",
    en: "Your activity will appear here",
  },
  activity_today: { ur: "Aaj", en: "Today" },
  activity_yesterday: { ur: "Kal", en: "Yesterday" },

  // Home
  home_accounts: { ur: "Accounts", en: "Accounts" },
  home_recent: { ur: "Recent", en: "Recent" },
  home_see_all: { ur: "See All", en: "See All" },
  home_no_accounts: { ur: "Koi Account Nahi", en: "No Accounts" },
  home_no_accounts_desc: {
    ur: "Pehle apna account banao — cash, bank, ya wallet",
    en: "Create your first account",
  },
  home_create_account: { ur: "Account Banao", en: "Create Account" },

  // Transaction page
  txpage_title: { ur: "Transactions", en: "Transactions" },
  txpage_all: { ur: "Sab", en: "All" },
  txpage_loans: { ur: "Qarz", en: "Loans" },
  txpage_none: { ur: "Koi Transaction Nahi", en: "No Transactions" },
  txpage_none_desc: {
    ur: "Apni pehli transaction add karo",
    en: "Add your first transaction",
  },
  txpage_add: { ur: "Transaction Daalo", en: "Add Transaction" },

  // Common
  fill_all: { ur: "Kuch missing hay, check kro", en: "Please fill all fields" },
  done_btn: { ur: "Theek Hai — Done!", en: "OK — Done!" },
  error: { ur: "Error", en: "Error" },
  naya: { ur: "Naya", en: "New" },
  category: { ur: "Category", en: "Category" },
  balance_changes: { ur: "Paisa Kahan Gaya", en: "Balance Changes" },
  updated: { ur: "Updated", en: "Updated" },
  tx_history: { ur: "Transaction History", en: "Transaction History" },
  no_tx: { ur: "Koi Transaction Nahi", en: "No Transactions" },
  no_tx_desc: {
    ur: "Is account mein abhi koi transaction nahi hui",
    en: "No transactions in this account yet",
  },

  // Validation
  insufficient_prefix: { ur: "", en: "" },
  insufficient_only: { ur: "mein sirf", en: "only has" },
  insufficient_suffix: {
    ur: "hain. Jitnay aap nay likhay hain, itnay pesay nahi hain.",
    en: "available. Insufficient funds.",
  },

  // Settings / Language
  settings_language: { ur: "Zuban", en: "Language" },
  lang_ur: { ur: "Roman Urdu", en: "Roman Urdu" },
  lang_en: { ur: "English", en: "English" },

  // Loans page title
  loans_title: { ur: "Qarz / Loans", en: "Loans" },
  goals_title: { ur: "Goals / Bachat", en: "Savings Goals" },

  // Time filters
  time_today: { ur: "Aaj", en: "Today" },
  time_yesterday: { ur: "Kal", en: "Yesterday" },
  time_this_week: { ur: "Is Hafta", en: "This Week" },
  time_last_week: { ur: "Pichla Hafta", en: "Last Week" },
  time_this_month: { ur: "Is Mahina", en: "This Month" },
  time_last_month: { ur: "Pichla Mahina", en: "Last Month" },
  time_this_year: { ur: "Is Saal", en: "This Year" },
  time_last_year: { ur: "Pichla Saal", en: "Last Year" },
  time_all: { ur: "Sab", en: "All" },
  time_results: { ur: "natije", en: "results" },

  // Upcoming expenses
  upcoming_title: { ur: "Aanay Walay Kharche", en: "Upcoming Expenses" },
  upcoming_none: {
    ur: "Koi Upcoming Kharcha Nahi",
    en: "No Upcoming Expenses",
  },
  upcoming_none_desc: {
    ur: "Apne aanay walay bills aur kharche yahan track karo",
    en: "Track your upcoming bills and expenses here",
  },
  upcoming_add: { ur: "Kharcha Add Karo", en: "Add Expense" },
  upcoming_new: { ur: "Naya Upcoming Kharcha", en: "New Upcoming Expense" },
  upcoming_name: { ur: "Kharche Ka Naam", en: "Expense Name" },
  upcoming_amount: { ur: "Kitna?", en: "How Much?" },
  upcoming_due: { ur: "Kab Dena Hai?", en: "Due Date?" },
  upcoming_account: { ur: "Kahan Se Jayega?", en: "From Which Account?" },
  upcoming_creating: { ur: "Bana Rahe Hain...", en: "Creating..." },
  upcoming_create: { ur: "Kharcha Banao", en: "Create Expense" },
  upcoming_due_in: { ur: "din baaqi", en: "days left" },
  upcoming_overdue: { ur: "Overdue!", en: "Overdue!" },
  upcoming_due_today: { ur: "Aaj Dena Hai!", en: "Due Today!" },
  upcoming_mark_paid: { ur: "Paid Mark Karo", en: "Mark Paid" },
  upcoming_warning: { ur: "Kharche Ka Warning", en: "Expense Warning" },
  upcoming_low_balance: { ur: "Balance Kam Hai", en: "Low Balance" },

  // FAB menu
  fab_add_goal: { ur: "Goal Banao", en: "Add Goal" },
  fab_add_expense: { ur: "Upcoming Kharcha", en: "Upcoming Expense" },
  fab_add_loan: { ur: "Naya Qarz", en: "New Loan" },

  // Dashboard upcoming widget
  home_upcoming: { ur: "Aanay Walay Kharche", en: "Upcoming Expenses" },
  home_see_all_upcoming: { ur: "Dekho Sab", en: "See All" },

  // Spending warning
  spend_warning_title: { ur: "Yaad Rakhein!", en: "Remember!" },
  spend_warning_msg_prefix: { ur: "", en: "" },
  spend_warning_msg_suffix: {
    ur: "ke liye chahiye hoga",
    en: "will be needed for",
  },
  spend_warning_continue: { ur: "Haan, Jaari Rakho", en: "Yes, Continue" },
  spend_warning_cancel: { ur: "Ruko, Baad Mein", en: "Wait, Later" },

  // Upcoming statuses
  upcoming_status_done: { ur: "Ho Gaya", en: "Done" },
  upcoming_status_cancel: { ur: "Cancel", en: "Cancel" },
  // Smart insights
  insight_month_spent: {
    ur: "Is mahine aapne {amount} kharcha kiya",
    en: "You spent {amount} this month",
  },
  insight_no_upcoming: {
    ur: "Koi upcoming kharcha nahi agle 7 dino mein",
    en: "No upcoming expenses in next 7 days",
  },

  // Account card stats
  acct_stat_month: { ur: "Is mahine", en: "This month" },

  // Empty state improvements
  empty_loans_title: { ur: "Koi qarz nahi", en: "No loans" },
  empty_loans_desc: {
    ur: "Kisi ko diya ya liya hua qarz yahan track karein",
    en: "Track loans given or taken here",
  },
  empty_loans_cta: { ur: "Qarz Add Karein", en: "Add Loan" },
  empty_goals_title: { ur: "Koi saving goal nahi", en: "No saving goals" },
  empty_goals_desc: {
    ur: "Apna pehla saving target set karein",
    en: "Set your first savings target",
  },
  empty_goals_cta: { ur: "Goal Banayein", en: "Create Goal" },
  empty_activity_title: { ur: "Koi activity nahi", en: "No activity" },
  empty_activity_desc: {
    ur: "Transactions karne ke baad sab kuch yahan nazar aayega",
    en: "Activity will appear after transactions",
  },
  empty_tx_title: { ur: "Koi transaction nahi", en: "No transactions" },
  empty_tx_desc: {
    ur: "Aaj ka pehla kharcha ya aamdani yahan add karein",
    en: "Add your first expense or income here",
  },
  empty_tx_cta: { ur: "Transaction Add Karein", en: "Add Transaction" },

  // Empty dashboard guidance
  empty_dash_title: { ur: "Sab set hai!", en: "All set!" },
  empty_dash_desc: {
    ur: "Ab apna pehla kharcha ya aamdani add karein neeche + button se",
    en: "Add your first expense or income using the + button below",
  },
  empty_dash_tap: { ur: "Neeche + dabayein", en: "Tap + below" },

  // First account celebration
  first_acct_congrats: { ur: "Mubarakbaad!", en: "Congratulations!" },
  first_acct_msg: {
    ur: "Aapka pehla account ban gaya. Ab hisaab rakhna shuru karein!",
    en: "Your first account is ready. Start tracking now!",
  },

  // ── Mode Selection ──
  mode_select_title: { ur: "Aapko Kya Chahiye?", en: "What Do You Need?" },
  mode_select_sub: {
    ur: "Baad mein Settings se badal sakte hain",
    en: "You can change this later in Settings",
  },
  mode_splits_title: { ur: "Splits Only", en: "Splits Only" },
  mode_splits_sub: {
    ur: "Accounts ke baghair logon aur groups ka hisaab",
    en: "People and group balances without accounts",
  },
  mode_splits_1: {
    ur: "Group mein kharche share karo",
    en: "Split expenses in groups",
  },
  mode_splits_2: {
    ur: "Kaun kitna dena hai — ek nazar mein",
    en: "See who owes whom at a glance",
  },
  mode_splits_3: {
    ur: "Payables aur receivables bhi dekhein",
    en: "View payables and receivables too",
  },
  mode_full_title: { ur: "Poora Hisaab Kitaab", en: "Full Money Tracker" },
  mode_full_sub: {
    ur: "Accounts, qarz, goals, splits — sab kuch",
    en: "Accounts, loans, goals, splits — everything",
  },
  mode_full_1: {
    ur: "Bank, cash, credit card accounts",
    en: "Bank, cash, credit card accounts",
  },
  mode_full_2: { ur: "Qarz aur EMI tracking", en: "Loan & EMI tracking" },
  mode_full_3: {
    ur: "Savings goals + group splits",
    en: "Savings goals + group splits",
  },

  mode_switch_blocked: { ur: "Switch Nahi Ho Sakta", en: "Cannot Switch Mode" },
  mode_switch_blocked_desc: {
    ur: "Pehle sab accounts ka balance zero karo",
    en: "All accounts must have zero balance first",
  },

  // ── Groups / Splits ──
  nav_groups: { ur: "Groups", en: "Groups" },
  groups_title: { ur: "Groups", en: "Groups" },
  group_new: { ur: "Naya Group Banao", en: "Create Group" },
  group_name: { ur: "Group Ka Naam", en: "Group Name" },
  group_name_placeholder: {
    ur: "e.g. Dubai Trip Boys",
    en: "e.g. Dubai Trip Boys",
  },
  group_emoji: { ur: "Emoji Chuno", en: "Pick Emoji" },
  group_members: { ur: "Members", en: "Members" },
  group_add_member: { ur: "Member Add Karo", en: "Add Member" },
  group_member_name: { ur: "Naam", en: "Name" },
  group_create: { ur: "Group Banao", en: "Create Group" },
  group_creating: { ur: "Bana Rahe Hain...", en: "Creating..." },
  group_created: { ur: "Group Ban Gaya!", en: "Group Created!" },
  group_you_owed: { ur: "Aapko milaingay", en: "You are owed" },
  group_you_owe: { ur: "Aapne denay hain", en: "You owe" },
  group_settled: { ur: "Barabar, Khalas", en: "All settled" },
  group_members_count: { ur: "members", en: "members" },
  group_empty: { ur: "Koi group nahi", en: "No groups yet" },
  group_empty_desc: {
    ur: "Dosto ke saath kharche share karne ke liye group banao",
    en: "Create a group to split expenses with friends",
  },
  groups_list_heading: { ur: "Aap ke groups", en: "Your groups" },
  groups_action_create_title: { ur: "Group Banao", en: "Create" },
  groups_action_create_sub: {
    ur: "Naya group shuru karo",
    en: "Start a new group",
  },
  groups_action_join_title: { ur: "Join Karo", en: "Join" },
  groups_action_join_sub: { ur: "Code ya link se", en: "Enter a code or link" },
  groups_edu_title: {
    ur: "Paison par behes khatam, Group Banao, Sabko pata ho kia kharch ho raha hay",
    en: "No more awkward money talk",
  },
  groups_edu_subtitle: {
    ur: "Har kharcha track, har hisaab clear. Dosti sirf dosti rahe Sahi hay na?",
    en: "Every shared rupee tracked. Every number, settled. Friendships stay friendships.",
  },
  groups_edu_split_title: {
    ur: "Kuch bhi Taqseem karna ho, Easy Scene hay",
    en: "Split anything, fairly",
  },
  groups_edu_split_body: {
    ur: "Kharchay ap karo, barabar taqseem ham kardaingy",
    en: "Dinner, rent, trips. We do the math \u2014 equal, exact, percentages, or shares.",
  },
  groups_edu_track_title: {
    ur: "Kisnay, Kiya Lena ya Dena hay, Sabko pata hoga",
    en: "Always know who owes what",
  },
  groups_edu_track_body: {
    ur: "Koi kharcha daale, balances wahin update. Zehn main rakhnay ki zarurat nahi",
    en: "Balances update the second anyone adds an expense. Stop keeping tabs in your head.",
  },
  groups_edu_settle_title: {
    ur: "Jab settlement karni ho, Ek click, hisaab barabar",
    en: "Settle with the fewest transfers",
  },
  groups_edu_settle_body: {
    ur: "Lena dena ham sath sath clear kar daingy, Ap end par wahi pay kro jo asal main dena banta hay",
    en: "We compress the web of debts so you only pay what actually matters.",
  },
  groups_edu_hint: {
    ur: "Akele bhi group bana sakte ho ap. \u2014 baad mein code share kar dena.",
    en: "Start solo now. Share the join code with friends whenever you\u2019re ready.",
  },
  groups_load_error_title: {
    ur: "Groups load ho rahy hain",
    en: "Couldn\u2019t load your groups",
  },
  groups_load_error_msg: {
    ur: "Dobara try karain please.",
    en: "Please try again.",
  },
  join_modal_title: { ur: "Group Join Karo", en: "Join a Group" },
  join_modal_label: {
    ur: "Group code ya invite link",
    en: "Group code or invite link",
  },
  join_modal_placeholder: {
    ur: "GRP-ABC123 ya link",
    en: "GRP-ABC123 or invite link",
  },
  join_modal_hint_title: {
    ur: "Code kahan milega?",
    en: "Where do I find a code?",
  },
  join_modal_hint_body: {
    ur: 'Group owner ke "Group Code" card se copy kar ke paste karo, ya invite link paste kar do.',
    en: "Ask the group owner to share the Group Code from their group screen, or paste the invite link they sent you.",
  },
  join_modal_submit: { ur: "Group Join Karo", en: "Join Group" },
  join_modal_joining: { ur: "Join ho raha hai...", en: "Joining..." },
  join_error_invalid: {
    ur: "Ye input samajh nahi aaya. GRP-XXXXXX code ya invite link paste karo.",
    en: "That doesn\u2019t look like a group code or invite. Paste a GRP-XXXXXX code or an invite link.",
  },
  join_error_not_found: {
    ur: "Ye code kisi group se match nahi karta. Owner se dobara check karo.",
    en: "That code doesn\u2019t match any group. Double-check with the owner.",
  },
  join_error_expired: {
    ur: "Ye invite expire ho chuki hai. Nai link mango.",
    en: "This invite has expired. Ask for a fresh link.",
  },
  join_error_network: {
    ur: "Network nahi mila. Connection check karo.",
    en: "Can\u2019t reach the server. Check your connection and try again.",
  },
  join_error_auth: {
    ur: "Pehle sign in karo.",
    en: "You need to sign in first.",
  },
  join_success_title: { ur: "Group join ho gaya", en: "You\u2019re in" },
  join_success_subtitle: {
    ur: "Ab mil ke pehla kharcha daalo",
    en: "Now log your first expense together",
  },
  group_created_subtitle: {
    ur: "Ab pehla kharcha daalo ya code share karo",
    en: "Next: add an expense or share the code to invite friends",
  },
  group_first_expense_title: {
    ur: "Pehla kharcha daalo",
    en: "Log the first expense",
  },
  group_first_expense_body: {
    ur: "Dinner? Uber? Jo bhi kharcha saath hua \u2014 daalo aur balances khud update ho jayenge.",
    en: "Dinner tonight? An Uber split? Drop it in and balances update for everyone instantly.",
  },
  group_first_expense_cta: { ur: "Kharcha add karo", en: "Add first expense" },
  group_solo_invite_title: {
    ur: "Sirf aap ho is group mein",
    en: "You\u2019re the only one here yet",
  },
  group_solo_invite_body: {
    ur: "Yeh code dosto ke saath share karo. Wo Groups screen se \u201cJoin\u201d kar ke daal denge.",
    en: "Share this code. Friends paste it in \u201cJoin\u201d on their Groups page and they\u2019re in.",
  },
  group_expense_add: { ur: "Kharcha Daalo", en: "Add Expense" },
  group_settle: { ur: "Settle Karo", en: "Settle Up" },
  group_expenses: { ur: "Kharche", en: "Expenses" },
  group_balances: { ur: "Balances", en: "Balances" },
  group_no_expenses: { ur: "Abhi koi kharcha nahi", en: "No expenses yet" },
  group_paid_by: { ur: "kisne pay kia?", en: "Paid By?" },
  group_expense_meta: {
    ur: "Kharch kia > {name}. {split}. Apka hissa {amount}",
    en: "Expense by: {name}. {split}. Your share {amount}",
  },
  group_paid_by_short: { ur: "Pay kia", en: "Paid by" },
  group_split_short: { ur: "Split", en: "Split" },
  group_your_share_short: { ur: "Apka hissa", en: "Your share" },
  group_split_between: { ur: "Kin Mein Bantna hay?", en: "Split Between?" },
  group_split_type: { ur: "Kaise Bantay?", en: "Split Type?" },
  group_split_equal: { ur: "Barabar", en: "Equal" },
  group_split_exact: { ur: "Exact Amount", en: "Exact" },
  group_split_pct: { ur: "Percentage", en: "Percentage" },
  group_split_shares: { ur: "Shares", en: "Shares" },
  group_each_pays: { ur: "Har ek dega", en: "Each pays" },
  group_total_mismatch: {
    ur: "Total match nahi kar raha",
    en: "Total does not match",
  },
  group_pct_mismatch: { ur: "Total 100% hona chahiye", en: "Must total 100%" },
  group_desc: { ur: "Kis cheez ka?", en: "What for?" },
  group_desc_placeholder: {
    ur: "e.g. Dinner at Laal Qila",
    en: "e.g. Dinner at Salt Bae",
  },
  group_amount: { ur: "Kitna?", en: "How much?" },
  group_save_expense: { ur: "Kharcha Save Karo", en: "Save Expense" },
  group_settle_title: { ur: "Settlement", en: "Settle Up" },
  group_settle_from: { ur: "Kisne Diya?", en: "Who Paid?" },
  group_settle_to: { ur: "Kisko Diya?", en: "Paid To?" },
  group_settle_amount: { ur: "Kitna?", en: "Amount?" },
  group_settle_note: { ur: "Note", en: "Note" },
  group_settle_save: { ur: "Settlement Save Karo", en: "Save Settlement" },
  group_owes: { ur: "nay denay hain", en: "owes" },
  group_to: { ur: "ko", en: "to" },
  group_delete: { ur: "Group Delete Karo", en: "Delete Group" },
  group_delete_confirm: {
    ur: "Kya aap yeh group delete karna chahte hain?",
    en: "Are you sure you want to delete this group?",
  },

  // ── Analytics ──
  nav_analytics: { ur: "Report", en: "Analytics" },
  analytics_title: { ur: "Analytics", en: "Analytics" },
  analytics_banner_desc: {
    ur: "Kharche aur aamdani ka mukammal jaiza",
    en: "View your spending & income insights",
  },
  analytics_spending: { ur: "Kharche Ka Hisaab", en: "Spending Overview" },
  analytics_categories: { ur: "Category Wise", en: "By Category" },
  analytics_trend: { ur: "Monthly Trend", en: "Monthly Trend" },
  analytics_daily: { ur: "Daily Kharcha", en: "Daily Spending" },
  analytics_top: { ur: "Sab Se Bade Kharche", en: "Top Expenses" },
  analytics_income_vs_expense: {
    ur: "Aamdani vs Kharcha",
    en: "Income vs Expense",
  },
  analytics_no_data: { ur: "Abhi koi data nahi", en: "No data yet" },
  analytics_this_month: { ur: "Is Maheene", en: "This Month" },
  analytics_last_month: { ur: "Pichle Maheene", en: "Last Month" },
  analytics_3months: { ur: "Pichle 3 Maheene", en: "Last 3 Months" },
  analytics_year: { ur: "Poora Saal", en: "Full Year" },
  analytics_total_spent: { ur: "Total Kharcha", en: "Total Spent" },
  analytics_total_income: { ur: "Total Aamdani", en: "Total Income" },
  analytics_currency: { ur: "Currency", en: "Currency" },
  analytics_group_spending: { ur: "Group Kharche", en: "Group Spending" },
  analytics_your_share: { ur: "Aapka Hissa", en: "Your Share" },

  // ── Settings ──
  nav_settings: { ur: "Settings", en: "Settings" },
  settings_title: { ur: "Settings", en: "Settings" },
  settings_app_mode: { ur: "App Mode", en: "App Mode" },
  settings_mode_current: { ur: "Abhi", en: "Current" },
  settings_switch_mode: { ur: "Mode Badlo", en: "Switch Mode" },
  settings_backup: { ur: "Backup & Restore", en: "Backup & Restore" },
  settings_export: { ur: "Data Export Karo", en: "Export Data" },
  settings_export_desc: {
    ur: "Apna sara data JSON file mein download karo",
    en: "Download all data as a JSON file",
  },
  settings_import: { ur: "Data Import Karo", en: "Import Data" },
  settings_import_desc: {
    ur: "Pehle se backup ki hui file se data restore karo",
    en: "Restore data from a backup file",
  },
  settings_import_warn: {
    ur: "Yeh current data replace kar dega. Pehle backup le lein?",
    en: "This will replace current data. Take a backup first?",
  },
  settings_import_success: {
    ur: "Data restore ho gaya!",
    en: "Data restored successfully!",
  },
  settings_import_fail: { ur: "Import fail ho gaya", en: "Import failed" },
  settings_security: { ur: "Security", en: "Security" },
  settings_set_pin: { ur: "PIN Set Karo", en: "Set PIN" },
  settings_change_pin: { ur: "PIN Badlo", en: "Change PIN" },
  settings_remove_pin: { ur: "PIN Hatao", en: "Remove PIN" },
  settings_pin_desc: {
    ur: "Yeh PIN sirf is device ke liye hai",
    en: "This PIN is for this device only",
  },
  settings_about: { ur: "Hisaab v2.0", en: "Hisaab v2.0" },
  settings_about_desc: {
    ur: "Aapka paisa, aapki nazar mein",
    en: "Your money, your way",
  },
  settings_contacts_tile: { ur: "Aap ke Contacts", en: "Your Contacts" },
  settings_contacts_tile_desc: {
    ur: "Loans aur splits ke linked log",
    en: "People linked to your loans and transactions",
  },
  settings_share_app: {
    ur: "Hisaab ka chota sa magic link",
    en: "Share Hisaab's tiny magic link",
  },
  settings_share_app_desc: {
    ur: "Doston ko app bhejo taake hisaab saath saath rahe",
    en: "Send the app to friends so every bill finds its buddy",
  },
  settings_share_app_badge: { ur: "Link ready", en: "Link ready" },
  settings_share_app_text: {
    ur: "Hisaab try karo - loans, splits aur daily paisay ek cute app mein.",
    en: "Try Hisaab - loans, splits, and daily money in one cute little app.",
  },
  settings_share_app_copied: {
    ur: "App link copy ho gaya",
    en: "App link copied",
  },
  settings_share_app_failed: {
    ur: "Share nahi ho saka",
    en: "Could not share the app",
  },

  // ── PIN Lock ──
  pin_title: { ur: "PIN Daalo", en: "Enter PIN" },
  pin_subtitle: { ur: "Apna 4-digit PIN daalo", en: "Enter your 4-digit PIN" },
  pin_wrong: { ur: "Ghalat PIN", en: "Wrong PIN" },
  pin_locked: { ur: "30 second ruko", en: "Wait 30 seconds" },
  pin_set_title: { ur: "Naya PIN Set Karo", en: "Set New PIN" },
  pin_confirm: { ur: "PIN Dobara Daalo", en: "Confirm PIN" },
  pin_mismatch: { ur: "PIN match nahi kiya", en: "PINs do not match" },
  pin_set_success: { ur: "PIN set ho gaya!", en: "PIN set successfully!" },
  pin_removed: { ur: "PIN hata diya", en: "PIN removed" },

  // ── Auth / Profile ──
  auth_skip: { ur: "Baad Mein dekhtay hain", en: "Skip for now" },
  auth_banner: {
    ur: "Apna account banao taake data safe rahe",
    en: "Create an account to keep your data safe",
  },
  auth_identifier: {
    ur: "Email ya Mobile Number",
    en: "Email or Mobile Number",
  },

  // ── Onboarding extras ──
  onboard_step_of: { ur: "ka", en: "of" },
  onboard_tagline: {
    ur: "Qarz, kharche aur splits ka saaf hisaab.",
    en: "Clear tracking for loans, expenses, and splits.",
  },
  onboard_bullet_1: {
    ur: "Loans, payables aur receivables track karein",
    en: "Track loans, payables, and receivables",
  },
  onboard_bullet_2: {
    ur: "Dekhein kisne dena hai aur aapne kisko dena hai",
    en: "Know who owes you and whom you owe",
  },
  onboard_bullet_3: {
    ur: "Polite reminder messages copy/share karein",
    en: "Copy or share polite reminder messages",
  },
  onboard_bullet_4: {
    ur: "Accounts, expenses aur group splits manage karein",
    en: "Manage accounts, expenses, and group splits",
  },
  onboard_start: { ur: "Shuru Karein", en: "Get Started" },
  onboard_footer: {
    ur: "Aapke records ke liye secure sync. Control aapke paas rehta hai.",
    en: "Secure sync for your records. You stay in control of your data.",
  },
  onboard_your_name: { ur: "Apna naam batayein", en: "What's your name?" },
  onboard_name_sub: {
    ur: "Hum aapko naam se bulayenge",
    en: "We'll greet you by name",
  },
  onboard_name_label: { ur: "Aapka Naam", en: "Your Name" },
  onboard_currency_label: { ur: "Primary Currency", en: "Primary Currency" },
  onboard_currency_help: {
    ur: "Apni main currency chunein. Baaki currencies ko alag alag track kar sakte hain.",
    en: "Choose your main currency. You can still track other currencies separately.",
  },
  onboard_next: { ur: "Aagay Chalein", en: "Continue" },
  onboard_safety_title: {
    ur: "Aapka Data, Aapka Control",
    en: "Your Data, Your Control",
  },
  onboard_safety_sub: {
    ur: "Aapke records securely store aur sync hote hain.",
    en: "Your records are securely stored and synced for your account.",
  },
  onboard_safety_1: {
    ur: "Financial records aapke account ke private rehte hain",
    en: "Your financial records stay private to your account",
  },
  onboard_safety_1_sub: {
    ur: "Sirf aap apne personal records access kar sakte hain.",
    en: "Only you can access your personal records.",
  },
  onboard_safety_2: {
    ur: "Sync se data devices par available rehta hai",
    en: "Sync keeps your data available across devices",
  },
  onboard_safety_2_sub: {
    ur: "Phone change ya reinstall par useful hai.",
    en: "Useful when you change phone or reinstall the app.",
  },
  onboard_safety_3: {
    ur: "Full account number kabhi mat daalein",
    en: "Never enter full account number",
  },
  onboard_safety_3_sub: {
    ur: "Last 4 digits ya nickname kaafi hain.",
    en: "Last 4 digits or nickname are enough.",
  },
  onboard_safety_4: {
    ur: "CVV, card PIN ya banking password kabhi mat daalein",
    en: "Never enter CVV, card PIN or banking password",
  },
  onboard_safety_4_sub: {
    ur: "Hisaab ko sensitive banking credentials ki zaroorat nahi.",
    en: "Hisaab does not need sensitive banking credentials.",
  },
  onboard_safety_5: { ur: "Hisaab bank nahi hai", en: "Hisaab is not a bank" },
  onboard_safety_5_sub: {
    ur: "Personal tracking ke liye use karein, banking replacement nahi.",
    en: "Use it for personal tracking, not as a banking replacement.",
  },
  onboard_safety_btn: {
    ur: "Samajh Gaya, Aage Chalein",
    en: "Got it, Continue",
  },
  onboard_safety_footer: {
    ur: "Yeh message dobara nahi aayega",
    en: "This message won't appear again",
  },
  onboard_how_start: { ur: "kaise shuru karein?", en: "how should we begin?" },
  onboard_how_sub: {
    ur: "Aap baad mein sab change kar sakte hain",
    en: "You can change everything later",
  },
  onboard_start_instruction: {
    ur: "Continue karne ke liye Start Fresh par tap karein.",
    en: "Tap Start Fresh to continue.",
  },
  onboard_demo_title: { ur: "Demo Data se Dekho", en: "Try with Demo Data" },
  onboard_demo_sub: {
    ur: "Pehle samjho, phir apna daalo",
    en: "Explore first, add yours later",
  },
  onboard_demo_desc: {
    ur: "Accounts, transactions, loans — sab tayar milega.",
    en: "Accounts, transactions, loans — all preloaded.",
  },
  onboard_fresh_title: { ur: "Fresh Start Karo", en: "Start Fresh" },
  onboard_fresh_sub: {
    ur: "Khali slate, apna hisaab",
    en: "Clean slate, your own records",
  },
  onboard_fresh_desc: {
    ur: "Seedha apne real accounts se shuru karein. Demo data nahi hoga.",
    en: "Start directly with your real accounts. No demo data will be added.",
  },
  onboard_fresh_desc_splits: {
    ur: "Accounts ke baghair logon aur groups ka hisaab shuru karein.",
    en: "Start tracking people and groups without accounts.",
  },
  onboard_fresh_cta: { ur: "Start Fresh", en: "Start Fresh" },
  onboard_fresh_tip_cash: {
    ur: "Sabse pehle apna cash wallet add karein.",
    en: "Add your cash wallet first.",
  },
  onboard_fresh_tip_bank: {
    ur: "Phir apna main bank account add karein.",
    en: "Add your main bank account next.",
  },
  onboard_fresh_tip_savings: {
    ur: "Savings account ho to woh bhi add kar lein.",
    en: "Add a savings account if you use one.",
  },
  onboard_fresh_tip_loans: {
    ur: "Jo paisa diya ya liya hai, loans mein track karein.",
    en: "Track money lent or borrowed from the loans area.",
  },
  onboard_fresh_tip_transactions: {
    ur: "Uske baad daily transactions record karna shuru karein.",
    en: "Then start recording daily transactions.",
  },
  onboard_fresh_tip_iou: {
    ur: "Jis ne dena ya lena hai, uska IOU record karein.",
    en: "Record who owes whom with IOUs.",
  },
  onboard_fresh_tip_groups: {
    ur: "Doston ya family ke group expenses split karein.",
    en: "Split shared expenses with friends or family groups.",
  },
  onboard_fresh_tip_contacts: {
    ur: "Notifications ke liye Hisaab contacts link karein.",
    en: "Link Hisaab contacts when they need to be notified.",
  },
  onboard_fresh_tip_reminders: {
    ur: "Zarurat par polite reminder message copy/share karein.",
    en: "Copy or share polite reminder messages when needed.",
  },
  onboard_linked_contacts_help: {
    ur: "Dusre person ko Hisaab notification bhejne ke liye unke paas bhi app hona chahiye. Unka code le kar Settings > Contacts mein link karein.",
    en: "To notify another person in Hisaab, they must also have the app and share their code. Link them from Settings > Contacts.",
  },
  onboard_loading: {
    ur: "Aapka Hisaab tayyar ho raha hai...",
    en: "Setting up your Hisaab...",
  },
  onboard_back: { ur: "← Wapas Jayen", en: "← Go Back" },

  // ── Account Detail ──
  acct_add_opening_bal: {
    ur: "Opening Balance Daalein",
    en: "Add Opening Balance",
  },
  acct_opening_bal_prompt: {
    ur: "Is account ka opening balance kitna hai?",
    en: "What's the opening balance of this account?",
  },
  acct_opening_title: { ur: "Opening Balance", en: "Opening Balance" },
  acct_opening_help: {
    ur: "Yeh sirf account ka starting balance set karega. Is mein expense, income ya category select karne ki zaroorat nahi.",
    en: "This only sets the account starting balance. No expense, income, or category selection is needed.",
  },
  acct_opening_amount: { ur: "Amount", en: "Amount" },
  acct_opening_date: { ur: "Date", en: "Date" },
  acct_opening_note_placeholder: { ur: "Optional note", en: "Optional note" },
  acct_opening_save: {
    ur: "Opening Balance Save Karein",
    en: "Save Opening Balance",
  },
  acct_opening_saved: {
    ur: "Opening balance save ho gaya",
    en: "Opening balance saved",
  },

  // ── Search ──
  search_placeholder: { ur: "Kharcha dhoondo...", en: "Search expenses..." },
  search_results: { ur: "nateeje", en: "results" },

  // ── My Account ──
  settings_my_account: { ur: "Mera Account", en: "My Account" },
  settings_my_account_desc: {
    ur: "Profile aur security settings",
    en: "Profile & security settings",
  },
  settings_email: { ur: "Email", en: "Email" },
  settings_mobile: { ur: "Mobile Number", en: "Mobile Number" },
  settings_password: { ur: "Password", en: "Password" },
  settings_reset_password: { ur: "Password Reset Karo", en: "Reset Password" },
  settings_save_profile: { ur: "Profile Save Karo", en: "Save Profile" },
  settings_profile_saved: { ur: "Profile save ho gaya!", en: "Profile saved!" },

  // ── Activity types ──
  activity_new: { ur: "Naya Entry", en: "New Entry" },
  activity_modified: { ur: "Badla Gaya", en: "Modified" },
  activity_deleted: { ur: "Hataya Gaya", en: "Deleted" },
  activity_settled: { ur: "Settle Hua", en: "Settled" },
  activity_transfer: { ur: "Transfer", en: "Transfer" },

  // PWA install
  pwa_install_title: { ur: "Hisaab Install Karo", en: "Install Hisaab" },
  pwa_install_cta: { ur: "Install", en: "Install" },
  pwa_install_native_sub: {
    ur: "App ko home screen par add karo",
    en: "Add the app to your home screen",
  },
  pwa_install_ios_sub: {
    ur: "Safari se home screen par add karo",
    en: "Add this app from Safari",
  },
  pwa_install_android_sub: {
    ur: "Browser menu se app install karo",
    en: "Install the app from your browser menu",
  },
  pwa_install_ios_steps: {
    ur: "Safari mein Share dabao, phir Add to Home Screen select karo.",
    en: "In Safari, tap Share, then choose Add to Home Screen.",
  },
  pwa_install_android_steps: {
    ur: "Browser menu kholo, phir Install app ya Add to Home screen chuno.",
    en: "Open the browser menu, then tap Install app or Add to Home screen.",
  },
  // ── Phase 2B: Linked Transaction Requests ──────────────────
  nav_inbox: { ur: "Inbox", en: "Inbox" },

  // Entry-form branching
  ltr_branch_helper: {
    ur: "Yeh direct save nahi hoga, pehle request ke taur par bheja jayega.",
    en: "This will be sent as a request instead of being recorded immediately.",
  },
  ltr_linked_only_helper: {
    ur: "Notifications sirf linked Hisaab contacts ke liye kaam karti hain.",
    en: "Notifications work only for linked Hisaab contacts.",
  },
  ltr_branch_cta: {
    ur: "Confirmation ke liye bhejo",
    en: "Send for confirmation",
  },

  // Toasts
  ltr_sent_title: {
    ur: "Confirmation ke liye bhej diya",
    en: "Sent for confirmation",
  },
  ltr_sent_subtitle: {
    ur: "Dusra user accept karega tabhi unke records mein add hoga.",
    en: "The other person must accept before it appears in their records.",
  },
  ltr_accept_error: {
    ur: "Accept nahi ho saka. Dobara koshish karein.",
    en: "Could not accept. Try again.",
  },
  ltr_reject_error: {
    ur: "Reject nahi ho saka. Dobara koshish karein.",
    en: "Could not reject. Try again.",
  },
  ltr_cancel_error: {
    ur: "Cancel nahi ho saka. Dobara koshish karein.",
    en: "Could not cancel. Try again.",
  },
  ltr_create_error: {
    ur: "Request nahi bhej saki. Dobara koshish karein.",
    en: "Could not send the request. Try again.",
  },

  // Inbox page
  ltr_inbox_title: { ur: "Inbox", en: "Inbox" },
  ltr_tab_incoming: { ur: "Aayi hui", en: "Incoming" },
  ltr_tab_outgoing: { ur: "Bheji hui", en: "Outgoing" },
  ltr_empty_incoming: {
    ur: "Abhi koi pending request nahi.",
    en: "No pending requests right now.",
  },
  ltr_empty_outgoing: {
    ur: "Aap ne koi request nahi bheji.",
    en: "You haven't sent any requests.",
  },
  ltr_incoming_hint: {
    ur: "Accept karne se dono taraf record banega. Yeh paisa move nahi karega.",
    en: "Accepting will record this loan on both sides. It will NOT move money.",
  },
  ltr_outgoing_hint: {
    ur: "Bhej di gayi hai. Abhi tak koi paisa move nahi hua.",
    en: "Sent for confirmation. No money has moved.",
  },

  // Request card descriptions
  ltr_card_lent: { ur: "{name} ko diya", en: "Lent to {name}" },
  ltr_card_borrowed: { ur: "{name} se liya", en: "Borrowed from {name}" },
  ltr_card_incoming_lent: {
    ur: "{name} kehta hai ke aap ko diya",
    en: "{name} says they lent you",
  },
  ltr_card_incoming_borrowed: {
    ur: "{name} kehta hai ke aap se liya",
    en: "{name} says they borrowed",
  },

  // Action buttons
  ltr_accept: { ur: "Accept", en: "Accept" },
  ltr_reject: { ur: "Reject", en: "Reject" },
  ltr_cancel: { ur: "Cancel", en: "Cancel" },
  ltr_accepting: { ur: "Accept ho raha…", en: "Accepting…" },
  ltr_rejecting: { ur: "Reject ho raha…", en: "Rejecting…" },
  ltr_cancelling: { ur: "Cancel ho raha…", en: "Cancelling…" },

  // Terminal state pills
  ltr_status_pending: { ur: "Pending", en: "Pending" },
  ltr_status_accepted: { ur: "Accepted", en: "Accepted" },
  ltr_status_rejected: { ur: "Rejected", en: "Rejected" },
  ltr_status_cancelled: { ur: "Cancelled", en: "Cancelled" },

  // Fallback person name for requests when contact details are missing
  ltr_unknown_person: { ur: "Hisaab user", en: "Hisaab user" },

  // ── Phase 2C-A: Linked Settlement Requests (ledger-only) ────
  stl_settle_cta: { ur: "Settlement Record Karein", en: "Record Settlement" },
  stl_title: { ur: "Settlement — {name}", en: "Settlement — {name}" },

  // Direction line, shown on the modal.
  stl_direction_paying_to: {
    ur: "Aap {name} ko {amount} adaa kar rahe hain.",
    en: "You'll mark {amount} as paid to {name}.",
  },
  stl_direction_receiving_from: {
    ur: "Aap {name} se {amount} receive mark kar rahe hain.",
    en: "You'll mark {amount} as received from {name}.",
  },

  stl_amount_label: { ur: "Kitni adaigi?", en: "How much?" },
  stl_amount_hint: { ur: "Baaki: {remaining}", en: "Remaining: {remaining}" },
  stl_note_label: { ur: "Note (Optional)", en: "Note (Optional)" },
  stl_send: { ur: "Confirmation ke liye bhejo", en: "Send for confirmation" },
  stl_sending: { ur: "Bhej raha…", en: "Sending…" },

  // Strong hint on every surface. Word-for-word per Phase 2C-A requirement.
  stl_ledger_only_hint: {
    ur: "Yeh dono taraf repayment record karega. Yeh aap ke account balance ko change nahi karega.",
    en: "This will record repayment in both records. It will NOT change your account balances.",
  },

  // Toasts
  stl_sent_title: { ur: "Settlement bhej di gayi", en: "Settlement sent" },
  stl_sent_subtitle: {
    ur: "Dusra user accept karega tabhi dono taraf repayment record hoga.",
    en: "The other person must accept before repayment is recorded on both sides.",
  },
  stl_create_error: {
    ur: "Settlement nahi bhej saki. Dobara koshish karein.",
    en: "Could not send the settlement. Try again.",
  },
  stl_accept_error: {
    ur: "Accept nahi ho saka. Dobara koshish karein.",
    en: "Could not accept. Try again.",
  },
  stl_reject_error: {
    ur: "Reject nahi ho saka. Dobara koshish karein.",
    en: "Could not reject. Try again.",
  },
  stl_cancel_error: {
    ur: "Cancel nahi ho saka. Dobara koshish karein.",
    en: "Could not cancel. Try again.",
  },
  stl_amount_invalid: {
    ur: "Amount galat hai. Baqaya se zyada nahi ho sakta.",
    en: "Invalid amount. It cannot exceed the remaining balance.",
  },

  // Inbox card strings
  stl_card_incoming: {
    ur: "{name} ne settlement record ki hai",
    en: "{name} marked a settlement",
  },
  stl_card_outgoing: {
    ur: "{name} kay liye settlement bheji",
    en: "Settlement sent to {name}",
  },

  // LoanDetailPage settlement history section
  stl_history_title: { ur: "Settlement history", en: "Settlement history" },
  stl_history_empty: {
    ur: "Abhi tak koi settlement nahi.",
    en: "No settlements yet.",
  },
  stl_history_view_in_inbox: {
    ur: "Inbox mein dekhein →",
    en: "View in Inbox →",
  },

  // Terminal state pills (share palette with ltr_status_*)
  stl_status_pending: { ur: "Pending", en: "Pending" },
  stl_status_accepted: { ur: "Accepted", en: "Accepted" },
  stl_status_rejected: { ur: "Rejected", en: "Rejected" },
  stl_status_cancelled: { ur: "Cancelled", en: "Cancelled" },

  // ── Phase 2C-B: sender-side optional apply-to-balance ──
  stl_apply_toggle_label: {
    ur: "Mere account mein apply karein",
    en: "Apply to one of my accounts",
  },
  stl_apply_toggle_hint: {
    ur: "Sirf is loan ki currency wale accounts use ho sakte hain.",
    en: "Only accounts in this loan's currency can be used.",
  },
  stl_apply_pick_account: { ur: "Account chunein", en: "Pick an account" },
  stl_apply_no_eligible: {
    ur: "Matching-currency ka koi account nahi. Ledger-only settlement phir bhi mojood hai.",
    en: "No matching-currency account. Ledger-only settlement is still available.",
  },
  // Strong new clarification shown when an account is selected.
  stl_apply_reduce_hint: {
    ur: "Jab dusra user accept karega tab aap ke account ka balance kam hoga.",
    en: "This will reduce your account balance when the other person accepts.",
  },
  stl_apply_increase_hint: {
    ur: "Jab dusra user accept karega tab aap ke account ka balance barhega.",
    en: "This will increase your account balance when the other person accepts.",
  },
  // Meta line on sender-side history for accepted settlements with an account.
  stl_applied_account: { ur: "Aap ke {account} par apply hua", en: "Applied to your {account}" },

  // ── Phase G7: minor standalone UI strings ──
  contacts_title: { ur: "Aap ke Contacts", en: "Your Contacts" },
  contacts_empty: { ur: "Abhi koi contact nahi.", en: "No contacts yet." },
  contacts_link_help: {
    ur: "Dusra person say kahain wo Hisaab use kare aur apna code ap kay sath share kare. Phir yahan link karne ke baad app connect ho jaogy aur loan/split approvals bheje ja sakte hain.",
    en: "The other person must also use Hisaab and share their code. After linking them here, loan and split approvals can be sent.",
  },
  edit_entry_title: { ur: "Entry Edit Karein", en: "Edit Entry" },
} as const;

type Key = keyof typeof S;

interface I18nState {
  lang: Language;
  setLang: (lang: Language) => void;
}

export const useI18nStore = create<I18nState>((set) => ({
  lang: (localStorage.getItem("hisaab_lang") as Language) || "ur",
  setLang: (lang) => {
    localStorage.setItem("hisaab_lang", lang);
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
