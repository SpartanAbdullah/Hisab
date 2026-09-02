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

  // Plain-language entry intents
  intent_spend: { ur: "Paisay Kharch Kiye", en: "Spend Money" },
  intent_spend_sub: { ur: "Account se paisay niklay", en: "Money leaves an account" },
  intent_receive: { ur: "Paisay Milay", en: "Receive Money" },
  intent_receive_sub: { ur: "Account mein paisay aaye", en: "Money enters an account" },
  intent_move: { ur: "Paisay Move Karein", en: "Move Money" },
  intent_move_sub: { ur: "Apne accounts ke darmiyan", en: "Between your accounts" },
  intent_person: { ur: "Kisi Ke Sath Paisay", en: "Money With Someone" },
  intent_person_sub: { ur: "Diya, liya ya wapsi", en: "Give, borrow, or pay back" },
  intent_group: { ur: "Group Kharcha", en: "Group Expense" },
  intent_group_sub: { ur: "Group mein split karein", en: "Split with a group" },
  intent_person_prompt: { ur: "Kya hua?", en: "What happened?" },
  person_gave: { ur: "Maine Paisay Diye", en: "I gave money" },
  person_gave_sub: { ur: "Ab woh mujhe wapas denge", en: "They will owe you" },
  person_borrowed: { ur: "Maine Paisay Liye", en: "I borrowed money" },
  person_borrowed_sub: { ur: "Ab main wapas dunga", en: "You will owe them" },
  person_paid_me_back: { ur: "Unhon Ne Wapas Diye", en: "They paid me back" },
  person_paid_me_back_sub: { ur: "Mera paisa wapas aya", en: "Reduce what they owe you" },
  person_i_paid_back: { ur: "Maine Wapas Diye", en: "I paid them back" },
  person_i_paid_back_sub: { ur: "Mera qarz kam hoga", en: "Reduce what you owe them" },
  confirm_loan_saved: { ur: "Qarz Save Ho Gaya", en: "Loan recorded" },
  confirm_repayment_saved: { ur: "Wapsi Save Ho Gayi", en: "Repayment recorded" },
  back: { ur: "Wapas", en: "Back" },
  add_entry: { ur: "Entry Add Karein", en: "Add Entry" },
  current_balance: { ur: "Mojooda Balance", en: "Current Balance" },
  add_money_entry: { ur: "Paisay Ki Entry Add Karein", en: "Add Money Entry" },
  recent_money_history: { ur: "Haal Ki Paisay Ki History", en: "Recent Money History" },
  settled: { ur: "Hisaab Barabar", en: "Settled" },
  cash_advance_source: { ur: "Credit Card Cash Advance", en: "Cash Advance Source" },
  paid_from: { ur: "Kis Account Se Pay Kia?", en: "Paid From" },
  group_dont_track: { ur: "Mere account mein track na karein", en: "Don't track in my accounts" },
  group_paid_from_hint: { ur: "Poora amount is account se minus hoga — settle-up par doosre wapas karenge.", en: "The full amount is deducted from this account — the others pay you back at settle-up." },
  group_paid_from_required: { ur: "Kis account se pay kiya woh chunein — ya “track na karein” select karein.", en: "Pick the account you paid from — or choose \"Don't track\"." },

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
  quick_type_instead: { ur: "Likhna pasand hai? Alfaaz mein likhein — “karak 3 aed”", en: "Prefer typing? Write it in words — “karak 3 aed”" },
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
  quick_loan_search_placeholder: { ur: "Naam se dhoondein…", en: "Search by name…" },
  // Type-first Quick Entry: the intent is picked first, so the amount screen
  // can ask the specific question instead of a context-free "How much?".
  qe_title_what_happened: { ur: "Kya hua?", en: "What happened?" },
  qe_amt_expense: { ur: "Kitna kharch hua?", en: "How much did you spend?" },
  qe_amt_income: { ur: "Kitna mila?", en: "How much did you receive?" },
  qe_amt_transfer: { ur: "Kitna move karna hai?", en: "How much are you moving?" },
  qe_amt_loan_given: { ur: "Kitna diya?", en: "How much did you give?" },
  qe_amt_loan_taken: { ur: "Kitna udhaar liya?", en: "How much did you borrow?" },
  qe_amt_repay_received: { ur: "Unhon ne kitna wapas kiya?", en: "How much did they pay back?" },
  qe_amt_repay_paid: { ur: "Aap ne kitna wapas kiya?", en: "How much did you pay back?" },
  qe_amt_goal: { ur: "Kitna bachana hai?", en: "How much are you setting aside?" },
  qe_amt_group: { ur: "Kitna kharcha hua?", en: "How much was spent?" },
  qe_amt_cash_advance: { ur: "Kitna cash nikala?", en: "How much cash did you take out?" },
  // Cash advance — first-class flow
  intent_cash_advance: { ur: "Cash Advance", en: "Cash Advance" },
  intent_cash_advance_sub: { ur: "Credit card se cash", en: "Cash from your credit card" },
  qe_ca_which_card: { ur: "Kaun sa card?", en: "Which card?" },
  qe_ca_locked: { ur: "{name} se cash advance", en: "Cash advance from {name}" },
  qe_ca_dest_label: { ur: "Cash kahan gaya?", en: "Where did the cash go?" },
  qe_ca_helper: { ur: "Card charge hoga aur ek repayable record banega — installments mein wapas karna ho to neeche EMI set karein.", en: "Your card will be charged and a repayable record created. Paying it back in installments? Set up the EMI plan below." },
  qe_ca_done_desc: { ur: "Cash advance record ho gaya — {amount} {card} se {account} mein.", en: "Cash advance recorded — {amount} from {card} into {account}." },
  acct_action_cash_advance: { ur: "Cash advance", en: "Cash advance" },
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
  // Received-amount-first conversion card. The user types what landed (or
  // what was deducted) on the other side; the rate is derived and shown in
  // both directions so there is no direction to get wrong.
  conv_ask_received: { ur: "Doosri taraf kitne {currency} aaye?", en: "How much {currency} arrived on the other side?" },
  conv_ask_paid: { ur: "Account se kitne {currency} gaye?", en: "How much {currency} left your account?" },
  conv_side_sending: { ur: "Bhej rahe hain", en: "Sending" },
  conv_side_arrives: { ur: "Pohanchenge", en: "Arrives" },
  conv_side_paying_back: { ur: "Ada kar rahe hain", en: "Paying" },
  conv_side_leaves: { ur: "Account se jayenge", en: "Leaves account" },
  conv_amount_placeholder: { ur: "e.g. 76,500", en: "e.g. 76,500" },
  conv_rate_placeholder: { ur: "e.g. 76.50", en: "e.g. 76.50" },
  conv_amount_implausible: { ur: "Yeh rate theek nahi lagta — dono amounts check karein.", en: "That rate looks off — double-check both amounts." },
  conv_enter_rate_instead: { ur: "Rate khud likhna hai?", en: "Know the rate? Enter it instead" },
  conv_enter_amount_instead: { ur: "Amount se hisaab karein", en: "Enter the amount instead" },
  conv_flip_direction: { ur: "Rate ki simt badlein", en: "Flip rate direction" },

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
  cc_owed: { ur: "Abhi kitna dena hai? (optional)", en: "Currently owed (optional)" },
  cc_owed_hint: { ur: "Agar card par pehle se kuch baqi hai to likhein — warna khali chhor dein (naya card).", en: "If you already owe something on this card, enter it — otherwise leave blank (new card)." },
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

  // Loan management (edit / money-free settle / delete)
  loan_edit_details: { ur: "Tafseel Badlein", en: "Edit details" },
  loan_edit_name: { ur: "Naam", en: "Name" },
  loan_edit_name_locked: {
    ur: "Yeh loan ek saved contact se juda hai — naam Contacts se aata hai.",
    en: "Linked to a saved contact — the name comes from Contacts.",
  },
  loan_edit_saved: { ur: "Loan update ho gaya", en: "Loan updated" },
  loan_settle_nomoney: { ur: "Baghair payment ke settle karein", en: "Settle without payment" },
  loan_settle_nomoney_title: { ur: "Loan settled mark karein?", en: "Mark this loan settled?" },
  loan_settle_nomoney_body: {
    ur: "Baqi {amount} settled record hoga — kisi account ka balance NAHI badlega. Jab paisa app ke bahar ada hua ho ya aap maaf kar rahe hon, yeh use karein.",
    en: "The remaining {amount} will be recorded as settled WITHOUT touching any account balance. Use this when it was paid outside the app, or you're writing it off.",
  },
  loan_settle_nomoney_cta: { ur: "Settled mark karo", en: "Mark settled" },
  loan_settle_nomoney_note: { ur: "Baghair payment ke settle", en: "Settled without payment" },
  loan_settle_nomoney_done: { ur: "Loan settle — koi paisa nahi hila", en: "Loan settled — no money moved" },
  loan_delete: { ur: "Loan delete karein", en: "Delete loan" },
  loan_delete_title: { ur: "Yeh loan delete karein?", en: "Delete this loan?" },
  loan_delete_body: {
    ur: "Loan, uske {n} record(s) aur qiston ka plan hat jayega — jo bhi account balances inhon ne badle thay wapas theek ho jayenge. Yeh wapas nahi ho sakta.",
    en: "This removes the loan, its {n} record(s) and any instalment plan, and restores every account balance they touched. This cannot be undone.",
  },
  loan_delete_cta: { ur: "Delete karo", en: "Delete loan" },
  loan_deleted: { ur: "Loan delete — balances wapas theek", en: "Loan deleted — balances restored" },
  ca_pill: { ur: "Cash advance", en: "Cash advance" },
  repay_card_covered_full: {
    ur: "{card} ka bill pehle se ada hai — yeh payment sirf is loan record ko update karegi. Card par dobara credit NAHI hoga.",
    en: "{card}'s bill is already covered — this payment will only update this loan record. The card will not be credited again.",
  },
  repay_card_covered_partial: {
    ur: "{card} apni limit ke qareeb hai — sirf {amount} card par wapas jayega.",
    en: "{card} is close to its limit — only {amount} will go back onto the card.",
  },

  // Account picker currency awareness + balance correction
  acct_rate_needed: { ur: "rate lagega", en: "rate needed" },
  acct_overpaid: { ur: "Zyada ada: {amount}", en: "Overpaid {amount}" },
  acct_over_limit_hint: {
    ur: "Available card ki limit se zyada hai — aksar iski wajah dobara record hui payment hoti hai. 'Balance theek karein' se isay durust karein.",
    en: "Available is above the card's limit — usually a double-recorded payment. Tap to fix it with a balance correction.",
  },
  acct_correct_balance: { ur: "Balance theek karein", en: "Correct balance" },
  acct_correct_title: { ur: "Balance theek karein", en: "Correct balance" },
  acct_correct_hint: {
    ur: "Jo balance ABHI asal mein hai woh likhein — farq ke liye ek correction entry record hogi jo baad mein delete bhi ho sakti hai.",
    en: "Enter what this balance ACTUALLY is right now — a correction entry is recorded for the difference (and can be deleted later).",
  },
  acct_correct_cta: { ur: "Correction save karo", en: "Save correction" },
  acct_correct_saved: { ur: "Balance theek ho gaya", en: "Balance corrected" },
  acct_correct_note: { ur: "Balance correction", en: "Balance correction" },
  action_adjusted: { ur: "Balance theek kiya", en: "Balance corrected" },

  // Delete/reversal recovery (blocked-delete family)
  err_reversal_spent: {
    ur: "{account} se woh paisay pehle hi kharch ho chuke hain — sirf {available} baqi hai. 'Phir bhi delete karein' se balance minus mein ja sakta hai, ya pehle {account} ka balance theek karein.",
    en: "That money was already spent from {account} — only {available} is left there. Delete anyway to let it go negative, or correct {account}'s balance first.",
  },
  del_anyway_title: { ur: "Paisay pehle hi kharch ho chuke", en: "Money already spent" },
  del_anyway_body: {
    ur: "{account} ke paas ab yeh raqam nahi hai. Delete karne par {account} ka balance {after} ho jayega — baad mein 'Balance theek karein' se durust kar sakte hain.",
    en: "{account} no longer holds this amount. Deleting will take {account} to {after} — you can fix it afterwards with Correct balance.",
  },
  del_anyway_cta: { ur: "Phir bhi delete karein", en: "Delete anyway" },
  err_linked_repayment_delete: {
    ur: "Yeh payment {person} ke sath linked loan ki hai. Sirf apni taraf se delete karne se dono ke records alag ho jayenge — loan page se settle ya adjust karein.",
    en: "This payment belongs to a loan linked with {person}. Deleting it one-sided would break both of your records — settle or adjust it from the loan page instead.",
  },
  tx_delete_no_undo_note: {
    ur: "Delete ho gaya. Balances wapas theek kar diye gaye hain.",
    en: "Deleted. The affected balances were restored.",
  },
  tx_readonly_note: {
    ur: "Yeh entry linked balances ki hifazat ke liye read-only hai. Delete karne par iske balance asraat wapas ho jate hain.",
    en: "This entry is kept read-only to protect linked balances. Deleting it reverses its balance effects and removes the entry.",
  },

  // Savings goal management
  goal_menu_edit: { ur: "Goal edit karein", en: "Edit goal" },
  goal_menu_correct: { ur: "Saved raqam theek karein", en: "Correct saved amount" },
  goal_menu_delete: { ur: "Goal delete karein", en: "Delete goal" },
  goal_manage: { ur: "Manage", en: "Manage" },
  goal_edit_saved: { ur: "Goal update ho gaya", en: "Goal updated" },
  goal_currency_locked: {
    ur: "Currency tab badal sakti hai jab kuch save na kiya ho.",
    en: "Currency can only change while nothing is saved yet.",
  },
  goal_delete_title: { ur: "Yeh goal delete karein?", en: "Delete this goal?" },
  goal_delete_body: {
    ur: "'{title}' hat jayega. Iski purani entries History mein rahengi aur account balances par koi asar nahi hoga.",
    en: "'{title}' will be removed. Its past entries stay in History and no account balance changes.",
  },
  goal_delete_cta: { ur: "Delete karo", en: "Delete goal" },
  goal_deleted: { ur: "Goal delete ho gaya", en: "Goal deleted" },
  goal_correct_title: { ur: "Saved raqam theek karein", en: "Correct saved amount" },
  goal_correct_hint: {
    ur: "Jo raqam WAQAI is goal ke liye rakhi hai woh likhein — sirf goal ka record badlega, koi account balance nahi.",
    en: "Enter what is ACTUALLY set aside for this goal — only the goal's record changes, no account balance moves.",
  },
  goal_correct_saved: { ur: "Saved raqam theek ho gayi", en: "Saved amount corrected" },
  goal_drift_warn: {
    ur: "{account} mein {balance} hai — yahan save shuda {saved} se kam.",
    en: "{account} holds {balance} — less than the {saved} saved here.",
  },
  goal_drift_fix: { ur: "Account se milao", en: "Match account" },
  goal_deadline: { ur: "Deadline (optional)", en: "Deadline (optional)" },
  group_delete_unsettled: {
    ur: "Is group mein abhi {amount} ke baqaya hisaab hain jo delete se ghayab ho jayenge.",
    en: "This group still has {amount} in unsettled debts that will vanish with it.",
  },
  stl_remove_title: { ur: "Yeh settlement hataein?", en: "Remove this settlement?" },
  stl_remove_body: {
    ur: "{from} → {to} ki {amount} wali settlement wapas ho jayegi aur balances dobara calculate honge.",
    en: "The {from} → {to} settlement of {amount} will be undone and balances recalculated.",
  },
  stl_remove_cta: { ur: "Hataein", en: "Remove" },
  stl_removed: { ur: "Settlement hata di gayi", en: "Settlement removed" },
  grp_only_creator_edit: {
    ur: "Sirf woh member jo yeh expense add kiya tha isay badal sakta hai.",
    en: "Only the member who added this expense can change it.",
  },
  grp_only_creator_delete: {
    ur: "Sirf woh member jo yeh expense add kiya tha isay delete kar sakta hai.",
    en: "Only the member who added this expense can delete it.",
  },
  grp_only_recorder_settlement: {
    ur: "Sirf woh member jo yeh settlement record ki thi isay hata sakta hai.",
    en: "Only the member who recorded this settlement can remove it.",
  },
  grp_creator_banner: {
    ur: "Sirf {name} (jisne yeh expense add kiya) isay edit ya delete kar sakta hai.",
    en: "Only {name} (who added this expense) can edit or delete it.",
  },
  grp_creator_banner_generic: {
    ur: "Sirf woh member jo yeh expense add kiya tha isay edit ya delete kar sakta hai.",
    en: "Only the member who added this expense can edit or delete it.",
  },
  grp_expense_not_deleted: { ur: "Expense delete nahi hua", en: "Expense not deleted" },
  // Optimistic-lock conflict on a shared group expense (audit F-6). The edit
  // was REJECTED, not merged — say so, or the user walks away believing their
  // change landed.
  grp_expense_version_conflict: {
    ur: "Kisi aur ne abhi yeh expense update kiya hai. Aapki tabdeeli save nahi hui — dobara kholein aur phir se karein.",
    en: "Someone else just updated this expense. Your change was not saved — reopen it and apply it again.",
  },
  // record_group_settlement RPC outcomes (audit F-7).
  grp_settle_signin: {
    ur: "Dobara sign in karein.",
    en: "Please sign in again.",
  },
  grp_settle_not_member: {
    ur: "Aap is group ke active member nahi hain.",
    en: "You are not an active member of this group.",
  },
  grp_settle_invalid_participants: {
    ur: "Yeh member group chhod chuka hai — settlement mein shaamil nahi ho sakta.",
    en: "This member has left the group and can't be part of a settlement.",
  },
  grp_settle_invalid_amount: {
    ur: "Zero se zyada amount likhein.",
    en: "Enter an amount greater than zero.",
  },
  grp_settle_already_settled: {
    ur: "Yeh hisaab pehle hi barabar ho chuka hai.",
    en: "This balance is already settled.",
  },
  grp_settle_exceeds: {
    ur: "Settlement baqaya {amount} se zyada nahi ho sakta.",
    en: "Settlement cannot exceed the outstanding {amount}.",
  },
  grp_settle_failed: {
    ur: "Settlement save nahi ho saki. Dobara koshish karein.",
    en: "Settlement could not be saved. Please try again.",
  },
  // ── Group notification templates ──
  // Server triggers write a template key + params; these render it in the
  // user's language (audit N-1: cross-user notification text used to be
  // English-only, frozen on the actor's device).
  ntf_someone: { ur: "Koi member", en: "A member" },
  ntf_the_group: { ur: "group", en: "the group" },
  ntf_an_expense: { ur: "Aik kharcha", en: "An expense" },
  ntf_group_added_title: { ur: "{group} mein add kiye gaye", en: "Added to {group}" },
  ntf_group_added_body: {
    ur: "{actor} ne aap ko aik shared group mein add kiya.",
    en: "{actor} added you to a shared group.",
  },
  ntf_member_joined_title: { ur: "{actor} {group} mein shaamil hue", en: "{actor} joined {group}" },
  ntf_member_joined_body: {
    ur: "{actor} ab group se connected hain.",
    en: "{actor} is now connected to the group.",
  },
  ntf_expense_added_title: { ur: "{actor} ne kharcha add kiya", en: "{actor} added an expense" },
  ntf_expense_added_body: {
    ur: "{group} mein {desc} — {amount} add hua.",
    en: "{desc} for {amount} was added in {group}.",
  },
  ntf_expense_added_body_plain: {
    ur: "{group} mein {desc} add hua.",
    en: "{desc} was added in {group}.",
  },
  ntf_expense_updated_title: { ur: "{actor} ne kharcha update kiya", en: "{actor} updated an expense" },
  ntf_expense_updated_body: {
    ur: "{group} mein {desc} badla gaya.",
    en: "{desc} was changed in {group}.",
  },
  ntf_expense_deleted_title: { ur: "{actor} ne kharcha delete kiya", en: "{actor} deleted an expense" },
  ntf_expense_deleted_body: {
    ur: "{group} se {desc} hata diya gaya.",
    en: "{desc} was removed from {group}.",
  },
  ntf_settlement_added_title: { ur: "{from} ne hisaab barabar kiya", en: "{from} settled up" },
  ntf_settlement_added_body: {
    ur: "{group} mein {from} ne {to} ko {amount} diye.",
    en: "{from} settled {amount} with {to} in {group}.",
  },
  ntf_settlement_added_body_plain: {
    ur: "{group} mein {from} ne {to} se hisaab barabar kiya.",
    en: "{from} settled up with {to} in {group}.",
  },
  ntf_settlement_deleted_title: { ur: "{actor} ne settlement hataya", en: "{actor} removed a settlement" },
  ntf_settlement_deleted_body: {
    ur: "{group} ka {from} → {to} settlement undo ho gaya.",
    en: "The {from} → {to} settlement in {group} was undone.",
  },
  ntf_no_shared_yet: {
    ur: "Abhi tak koi shared notification nahi.",
    en: "No shared notifications yet.",
  },
  ntf_new_connection: { ur: "Naya connection", en: "New connection" },
  qe_group_one_loan: { ur: "1 qarz", en: "1 loan" },
  edit_date_label: { ur: "Tareekh", en: "Date" },
  edit_date_hint: {
    ur: "Budget aur analytics is nayi tareekh ke mahine mein ginenge.",
    en: "Budgets and analytics will count this under the new date's month.",
  },
  edit_rate_label: { ur: "Rate ({src} → {dst})", en: "Rate ({src} → {dst})" },
  tx_group_orphan_note: {
    ur: "Jis group se yeh entry judi thi woh delete ho chuka hai — ab yeh aam entry hai jise aap delete kar sakte hain.",
    en: "The group this entry belonged to was deleted — it's a normal entry now and can be deleted here.",
  },
  lsr_err_account_deleted: {
    ur: "Bhejne wale ne woh account delete kar diya jis se yeh settlement judna thi. Un se kahein request cancel kar ke dobara bhejein, ya aap isay reject kar dein.",
    en: "The sender deleted the account this settlement was tied to. Ask them to cancel and re-send it, or reject this request.",
  },
  lsr_err_amount_exceeds: {
    ur: "Raqam ab kisi ek taraf ke baqaya se zyada hai (shayad darmiyan mein koi payment record hui). Request reject kar ke nayi bhejwayein.",
    en: "The amount now exceeds what's left on one side (a payment was likely recorded in between). Reject this and have a fresh one sent.",
  },
  lsr_err_loan_inactive: {
    ur: "Yeh loan ab active nahi raha — request purani ho chuki hai. Isay reject kar dein.",
    en: "That loan is no longer active — this request is stale. Reject it.",
  },
  lsr_err_not_target: {
    ur: "Yeh request aap ke liye nahi hai.",
    en: "This request isn't addressed to you.",
  },
  lsr_err_not_found: {
    ur: "Yeh request ab mojood nahi (shayad cancel ho gayi). Inbox refresh karein.",
    en: "This request no longer exists (it may have been cancelled). Refresh your inbox.",
  },
  // Stale-schema fallback: the server hasn't accepted the widened currency
  // list yet (supabase-migration-audit-p0-currencies.sql). Never a client-side
  // block — all 8 currencies stay selectable in the UI.
  ltr_err_currency_unsupported: {
    ur: "Yeh currency abhi server par cross-user udhaar ke liye enable nahi hui, is liye request nahi bheji ja saki. Filhaal isay apne apne hisaab mein local record karein, ya AED/PKR mein bhejein.",
    en: "This currency isn't enabled for cross-user udhaar on the server yet, so the request wasn't sent. Record it in your own ledger for now, or send it in AED/PKR.",
  },
  lsr_err_currency_unsupported: {
    ur: "Yeh currency abhi server par settlement request ke liye enable nahi hui. Payment aap dono apne apne hisaab mein khud record kar lein, ya AED/PKR wale loan par settle karein.",
    en: "This currency isn't enabled for settlement requests on the server yet. Record the payment in each of your own ledgers for now, or settle a loan in AED/PKR.",
  },

  // Trust-led onboarding + intent routing (Monarch-inspired quick wins)
  onboard_bullet_0: {
    ur: "Bank ka password nahi chahiye — kabhi nahi",
    en: "No bank passwords. No sync to break.",
  },
  onboard_intent_title: {
    ur: "Aap Hisaab kis liye use karenge?",
    en: "What brings you to Hisaab?",
  },
  onboard_intent_sub: {
    ur: "Hum aap ka pehla din isi hisaab se set karenge.",
    en: "We'll shape your first day around it.",
  },
  onboard_intent_spending: { ur: "Apna kharcha track karna hai", en: "Track my spending" },
  onboard_intent_loans: { ur: "Udhaar ka hisaab rakhna hai", en: "Keep track of loans (udhaar)" },
  onboard_intent_kameti: { ur: "Kameti chalani ya track karni hai", en: "Run or track a kameti" },
  onboard_intent_splits: { ur: "Doston ke sath kharche baantne hain", en: "Split expenses with friends" },
  onboard_intent_budgets: { ur: "Budget banana aur bachana hai", en: "Set budgets and save" },
  onboard_intent_skip: { ur: "Sab kuch dekhna hai", en: "A bit of everything" },

  // Home "This week" forward view
  home_this_week: { ur: "Is haftay", en: "This week" },
  home_week_out: { ur: "{amount} jane hain", en: "{amount} going out" },
  home_week_more: { ur: "+{n} aur is haftay", en: "+{n} more this week" },
  tw_rounds_count: { ur: "Is haftay {c} baariyan", en: "{c} rounds this week" },
  tw_cad_daily: { ur: "Rozana", en: "Daily" },
  tw_cad_weekly: { ur: "Haftawar", en: "Weekly" },
  tw_cad_monthly: { ur: "Mahana", en: "Monthly" },
  tw_cad_yearly: { ur: "Salana", en: "Yearly" },

  // Mera Hisaab net-position card + payee memory
  home_mera_hisaab: { ur: "Mera Hisaab", en: "Where I Stand" },
  mh_receivable: { ur: "Log denge", en: "Owed to you" },
  mh_payable: { ur: "Aap ne dene", en: "You owe" },
  mh_vs_last: { ur: "pichle mahine se", en: "vs last month" },
  qe_payee_filled: {
    ur: "Pichli dafa se bhar diya — {category}",
    en: "Filled from last time — {category}",
  },
  qe_payee_refile_q: {
    ur: "{payee} hamesha {category} mein file karein?",
    en: "Always file {payee} under {category}?",
  },
  qe_payee_refile_action: { ur: "{n} purani update karo", en: "Update {n} past" },
  qe_payee_refiled: { ur: "{n} purani entries update ho gayin", en: "{n} past entries re-filed" },

  // Settings trust section
  trust_title: { ur: "Aap ka paisa, aap ka data", en: "Your money, your data" },
  trust_line_1: {
    ur: "Hisaab sirf record rakhta hai — aap ke paise ko haath nahi laga sakta.",
    en: "Hisaab only keeps records — it can't touch your money.",
  },
  trust_line_2: {
    ur: "Bank ka password ya PIN kabhi nahi manga jata.",
    en: "It never asks for a bank password or PIN.",
  },
  trust_line_3: {
    ur: "Aap ka data kabhi becha nahi jata, aur ads kabhi nahi aayenge.",
    en: "Your data is never sold, and there will never be ads.",
  },
  trust_line_4: {
    ur: "Har ghalti wapas ho sakti hai — koi entry hamesha ke liye phansti nahi.",
    en: "Every mistake can be undone — no entry is ever stuck forever.",
  },
  trust_why_free_title: { ur: "Hisaab free kyun hai?", en: "Why is Hisaab free?" },
  trust_why_free_body: {
    ur: "Rozmarra ka hisaab hamesha free rahega. Aage chal kar kuch premium extras aa sakte hain — lekin ads ya data bech kar kamai kabhi nahi hogi. Hum kahin nahi ja rahe.",
    en: "Everyday tracking stays free, always. Premium extras may come later — but we will never make money from ads or from selling your data. We're not going anywhere.",
  },

  // Recurring expansion safety
  rec_posted_advance_failed: {
    ur: "Entry post ho gayi, lekin agli due date aage nahi barh saki — agli baar dobara pooch sakta hai. Dobara confirm NA karein.",
    en: "The entry was posted, but the next due date couldn't move — it may ask again later. Do NOT confirm it twice.",
  },
  rec_already_posted: {
    ur: "Yeh charge is due date ke liye pehle hi post ho chuka hai.",
    en: "This charge was already posted for this due date.",
  },
  rec_posted_on_due: { ur: "{date} ki tareekh par record hoga", en: "Will be recorded on its due date, {date}" },

  // Soft payment reminders
  reminder_title: { ur: "Reminder Message", en: "Reminder Message" },
  reminder_cta: { ur: "Remind", en: "Remind" },
  reminder_copy: { ur: "Copy", en: "Copy" },
  reminder_share: { ur: "Share", en: "Share" },
  reminder_whatsapp: { ur: "WhatsApp pe bhejo", en: "Send on WhatsApp" },
  reminder_wa_opening: { ur: "WhatsApp khul raha hai…", en: "Opening WhatsApp…" },
  reminder_wa_to_name: {
    ur: "{name} ke saath WhatsApp chat khulegi — bas Send dabana hai.",
    en: "Opens a WhatsApp chat with {name} — just tap send.",
  },
  reminder_wa_pick: {
    ur: "Number save nahi — WhatsApp mein {name} ko chunna hoga.",
    en: "No number saved — you'll pick {name} in WhatsApp.",
  },
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

  // Statement of Account (SOA) — a per-contact / per-loan statement that can
  // be sent as a one-page PDF (native share) or a text ping over WhatsApp.
  soa_title: { ur: "Hisaab ka statement", en: "Statement of account" },
  soa_cta: { ur: "Statement bhejein", en: "Send statement" },
  soa_send_pdf: { ur: "PDF statement bhejein", en: "Send statement (PDF)" },
  soa_preparing: { ur: "Tayyar ho raha hai…", en: "Preparing…" },
  soa_whatsapp_text: { ur: "WhatsApp text", en: "WhatsApp text" },
  soa_copy: { ur: "Copy", en: "Copy text" },
  soa_copied: { ur: "Statement copy ho gaya", en: "Statement copied" },
  soa_copy_failed: { ur: "Copy nahi ho saka", en: "Could not copy" },
  soa_ready: { ur: "Statement bhejne ke liye tayyar", en: "Statement ready to share" },
  soa_downloaded: { ur: "Statement download ho gaya", en: "Statement downloaded" },
  soa_share_failed: { ur: "Statement nahi ban saka", en: "Could not create the statement" },
  soa_preview: { ur: "Preview", en: "Preview" },
  soa_none: { ur: "{name} ke saath abhi koi hisaab nahi.", en: "No loan history with {name} yet." },
  soa_settled_chip: { ur: "Sab clear", en: "All clear" },
  soa_settled_celebrate: {
    ur: "Mubarak ho! {name} ke saath hisaab bilkul barabar hai 🎉",
    en: "Congratulations! Nothing pending with {name} — all settled 🎉",
  },
  soa_nudge_intro: {
    ur: "Payment save ho gayi. {name} ko naya statement bhejein?",
    en: "Payment recorded. Send {name} an updated statement?",
  },
  soa_greeting_label: { ur: "Salaam (greeting)", en: "Greeting" },
  soa_greet_hello: { ur: "Hello", en: "Hello" },
  soa_greet_salaam: { ur: "Salaam", en: "Salaam" },
  soa_greet_dear: { ur: "Dear", en: "Dear" },
  soa_greet_none: { ur: "None", en: "None" },
  soa_hide_amounts: { ur: "Raqam chhupayein", en: "Hide amounts" },
  soa_hide_amounts_sub: { ur: "Structure aur naam nazar aayenge, raqam nahi — share ke liye behtar.", en: "Names, dates and structure stay visible — the numbers don't." },
  kslip_hide_witness_note: { ur: "Witness link par asal raqam phir bhi nazar aayegi.", en: "The witness link still shows the real amounts." },

  // Payment-received receipt — a warm acknowledgement sent back to the payer.
  rcpt_title: { ur: "Payment mil gayi", en: "Payment received" },
  rcpt_nudge_intro: {
    ur: "Payment mil gayi. {name} ko receipt bhejein?",
    en: "Payment received. Send {name} a receipt?",
  },
  rcpt_toggle_receipt: { ur: "Receipt", en: "Receipt" },
  rcpt_toggle_statement: { ur: "Statement", en: "Statement" },
  rcpt_received: { ur: "Mil gaye", en: "Received" },
  rcpt_thanks_short: { ur: "Shukriya — record ho gaya.", en: "Thanks — recorded." },
  rcpt_settled_short: { ur: "Mubarak ho — ab hisaab bilkul barabar! 🎉", en: "Congratulations — all settled now! 🎉" },
  rcpt_remaining_short: { ur: "Baqi {amount}", en: "Remaining {amount}" },

  // Group settle-up sheet — the statement, for splits.
  gsu_title: { ur: "Hisaab barabar karein", en: "Settle up" },
  gsu_cta: { ur: "Settle-up share karein", en: "Share settle-up" },
  gsu_intro: {
    ur: "Har banday ko WhatsApp par bhejein — kis ne kya dena hai ya lena hai. Woh Hisaab par ho ya na ho.",
    en: "Send each person exactly what they owe or get back — over WhatsApp, even if they're not on Hisaab.",
  },
  gsu_for_member: { ur: "Kis ke liye card", en: "Send card for" },
  gsu_send_card: { ur: "WhatsApp card", en: "WhatsApp card" },
  gsu_full_plan_pdf: { ur: "Poora plan (PDF)", en: "Full plan (PDF)" },
  gsu_you_receive: { ur: "Aap ko total {amount} milega", en: "You'll receive {amount} overall" },
  gsu_you_pay: { ur: "Aap ko total {amount} dena hai", en: "You need to pay {amount} overall" },
  gsu_settled: { ur: "Aap ka hisaab barabar hai", en: "You're all settled up" },
  gsu_pick_hint: { ur: "Number save nahi — WhatsApp mein chunna hoga.", en: "No number saved — you'll pick them in WhatsApp." },

  // Kameti payout slip.
  kslip_title: { ur: "Kameti payout slip", en: "Kameti payout slip" },
  kslip_pdf: { ur: "Slip bhejein (PDF)", en: "Send slip (PDF)" },
  kslip_received: { ur: "Payout", en: "Payout" },
  kslip_received_line: {
    ur: "Aap ko {amount} mile — Round {r} of {n}.",
    en: "You received {amount} — Round {r} of {n}.",
  },
  kslip_intro: { ur: "{name} ne Round {r} ka payout liya.", en: "{name} took the Round {r} payout." },
  kslip_verify: { ur: "Live verify karein", en: "Verify live" },
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
  home_no_accounts: { ur: "Pehle ek account banao", en: "Add an account first" },
  home_no_accounts_desc: {
    ur: "Cash, bank, ya wallet — jahan se paisa chalta hai, wahin se shuru karo",
    en: "Cash, bank, or wallet — anywhere your money lives, start there",
  },
  home_no_accounts_subhint: {
    ur: "Saari currencies support hain — AED, PKR, SAR aur baqi GCC.",
    en: "All major currencies supported — AED, PKR, SAR and the rest of GCC.",
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
  txpage_add: { ur: "Entry Daalo", en: "Add Entry" },

  // Common
  fill_all: { ur: "Kuch missing hay, check kro", en: "Please fill all fields" },
  done_btn: { ur: "Theek Hai — Done!", en: "OK — Done!" },
  error: { ur: "Error", en: "Error" },
  naya: { ur: "Naya", en: "New" },
  category: { ur: "Category", en: "Category" },
  // Custom categories
  cat_add_new: { ur: "Nayi", en: "New" },
  cat_new_placeholder: { ur: "Category ka naam", en: "Category name" },
  cat_added: { ur: "Category ban gayi", en: "Category added" },
  cat_save: { ur: "Save", en: "Save" },
  cat_err_empty: { ur: "Naam likhein", en: "Enter a name" },
  cat_err_too_long: { ur: "Naam chhota rakhein", en: "Name is too long" },
  cat_err_duplicate: { ur: "Ye category pehle se hai", en: "That category already exists" },
  contact_dup_link_named: { ur: "Aap pehle se in se apne contact “{name}” ke zariye juday hain — usi ko kholein.", en: "You're already connected to them through your contact “{name}” — open that one instead." },
  contact_dup_link_generic: { ur: "Aap ka ek aur contact pehle se is user se juda hua hai.", en: "Another of your contacts is already linked to this user." },
  cat_manage_title: { ur: "Categories", en: "Categories" },
  cat_manage_row: { ur: "Categories manage karein", en: "Manage categories" },
  cat_manage_sub: { ur: "Apni categories banayein", en: "Add your own categories" },
  cat_expense_tab: { ur: "Kharcha", en: "Expense" },
  cat_income_tab: { ur: "Amdani", en: "Income" },
  cat_built_in: { ur: "Built-in", en: "Built-in" },
  cat_your_own: { ur: "Aapki categories", en: "Your categories" },
  cat_none_custom: { ur: "Abhi koi custom category nahi", en: "No custom categories yet" },
  cat_add_placeholder: { ur: "Nayi category likhein", en: "Add a new category" },
  cat_add_button: { ur: "Add karein", en: "Add" },
  cat_delete_confirm_title: { ur: "Category hata dein?", en: "Delete category?" },
  cat_delete_confirm_body: {
    ur: "Purani entries par asar nahi hoga — sirf list se hategi.",
    en: "Past entries keep their label — this only removes it from the list.",
  },
  cat_deleted: { ur: "Category hata di", en: "Category removed" },
  cat_remove: { ur: "Hata dein", en: "Remove" },
  // Receipt photos
  receipt_label: { ur: "Receipt", en: "Receipt" },
  receipt_add: { ur: "Receipt lagayein", en: "Add receipt" },
  receipt_uploading: { ur: "Upload ho raha hai…", en: "Uploading…" },
  receipt_attached: { ur: "Receipt lagi hui hai", en: "Receipt attached" },
  receipt_replace: { ur: "Badlein", en: "Replace" },
  receipt_added: { ur: "Receipt lag gayi", en: "Receipt added" },
  receipt_removed: { ur: "Receipt hata di", en: "Receipt removed" },
  receipt_failed: { ur: "Receipt save nahi hui", en: "Couldn't save receipt" },
  receipt_not_image: { ur: "Sirf tasveer lagayein", en: "Please choose an image" },
  receipt_remove_title: { ur: "Receipt hata dein?", en: "Remove receipt?" },
  balance_changes: { ur: "Paisa Kahan Gaya", en: "Balance Changes" },
  updated: { ur: "Updated", en: "Updated" },
  tx_history: { ur: "Transaction History", en: "Transaction History" },
  no_tx: { ur: "Is account mein abhi kuch nahi", en: "Quiet account" },
  no_tx_desc: {
    ur: "Jo pehla kharcha ya amdani hogi, woh yahan nazar aayegi",
    en: "The first transaction on this account will land here",
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
  settings_appearance: { ur: "Look", en: "Appearance" },
  logout_confirm_title: { ur: "Logout karein? 👋", en: "Log out? 👋" },
  logout_confirm_body: { ur: "Wapas aane ke liye bas email aur password chahiye. Aap ka data mehfooz aur synced rahega. 🔒", en: "You'll just need your email & password to come back. Your data stays safe and synced. 🔒" },
  logout_confirm_yes: { ur: "Logout", en: "Log out" },
  // Unsaved-changes discard guard (shared across data-entry modals)
  discard_title: { ur: "Yeh entry chhoṛ dein?", en: "Discard this entry?" },
  discard_body: { ur: "Aap ke un-save kiye hue changes chale jayenge.", en: "Your unsaved changes will be lost." },
  discard_yes: { ur: "Chhoṛ dein", en: "Discard" },
  discard_keep: { ur: "Editing jari rakhein", en: "Keep editing" },
  // Undo (toast action) — used for reversible deletes/cancels
  undo: { ur: "Undo", en: "Undo" },
  undo_failed: { ur: "Undo nahi ho saka", en: "Couldn't undo" },
  tx_deleted: { ur: "Entry delete ho gayi", en: "Entry deleted" },
  upcoming_cancelled: { ur: "Cancel kar diya", en: "Marked cancelled" },
  // Inbox reject / withdraw confirms (shared by loan requests + settlements)
  inbox_reject_confirm_title: { ur: "Yeh request decline karein?", en: "Decline this request?" },
  inbox_reject_confirm_body: { ur: "Yeh haṭ jayega aur dusre shakhs ko pata chal jayega ke aap ne decline kiya.", en: "It'll be removed and the other person will see that you declined." },
  inbox_reject_confirm_cta: { ur: "Decline", en: "Decline" },
  inbox_cancel_confirm_title: { ur: "Yeh request wapas lein?", en: "Withdraw this request?" },
  inbox_cancel_confirm_body: { ur: "Yeh unke Inbox se haṭ jayega. Aap baad mein dobara bhej sakte hain.", en: "It'll be removed from their Inbox. You can send it again later." },
  inbox_cancel_confirm_cta: { ur: "Wapas lein", en: "Withdraw" },
  // Settings: turn off PIN (security downgrade)
  pin_remove_confirm_title: { ur: "Apna PIN band karein?", en: "Turn off your PIN?" },
  pin_remove_confirm_body: { ur: "App khulte waqt PIN nahi maangega. Jis ke pass aap ka phone unlocked ho woh ise khol sakega.", en: "The app will stop asking for a PIN to open. Anyone with your unlocked phone could open it." },
  pin_remove_confirm_cta: { ur: "PIN band karein", en: "Turn off PIN" },
  // Linked-loan settlement send confirm
  stl_confirm_title: { ur: "Yeh settlement request bhejein?", en: "Send this settlement request?" },
  stl_confirm_body: { ur: "{amount} dusre shakhs ko confirm karne ke liye jayega. Dono loans tabhi settled honge jab woh accept karenge.", en: "{amount} will be sent to the other person to confirm. Both loans are marked settled only after they accept." },
  stl_confirm_balance_note: { ur: "Unke accept karte hi aap ke account ka balance update ho jayega.", en: "Your account balance updates once they accept." },
  stl_confirm_cta: { ur: "Request bhejein", en: "Send request" },
  stl_amount_over: { ur: "Yeh baqi raqam se zyada hai.", en: "That's more than what's left to settle." },
  reconcile_failed: { ur: "Reconcile update nahi hua — dobara koshish karein.", en: "Couldn't update — tap to try again." },
  reconcile_tip_todo: { ur: "Tick karein jab yeh aap ke asli account se mil jaye", en: "Tick this off once it matches your real account" },
  reconcile_tip_done: { ur: "Milaan ho gaya — aap ke account se match karta hai", en: "Checked off — matches your real account" },
  settings_appearance_desc: { ur: "Light, dark ya system", en: "Light, dark, or match system" },
  theme_light: { ur: "Light", en: "Light" },
  theme_dark: { ur: "Dark", en: "Dark" },
  theme_system: { ur: "System", en: "System" },
  lang_ur: { ur: "Roman Urdu", en: "Roman Urdu" },
  lang_en: { ur: "English", en: "English" },
  onboard_language_label: { ur: "Apni zabaan chunein", en: "Choose your language" },

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
  upcoming_done_toast: { ur: "“{title}” reminder hata diya — aap ke balance par asar nahi hua.", en: "“{title}” reminder cleared — this didn't change your balance." },
  upcoming_log_expense: { ur: "Kharcha darj karein", en: "Log the expense" },
  upcoming_logged: { ur: "{amount} kharcha darj ho gaya", en: "Logged {amount} as an expense" },
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
  empty_loans_title: { ur: "Koi qarz nahi", en: "All clear" },
  empty_loans_desc: {
    ur: "Kisi ko diya ya liya — sab yahan track ho jata hai",
    en: "No money out, none coming in. Add a loan when one starts.",
  },
  empty_loans_subhint: {
    ur: "Sukoon ki baat hai — hisaab barabar hai \u{1F319}",
    en: "Sukoon. Nothing to chase, nothing chasing you \u{1F319}",
  },
  empty_loans_cta: { ur: "Qarz Add Karein", en: "Add Loan" },
  empty_goals_title: { ur: "Koi goal nahi", en: "No goals yet" },
  empty_goals_desc: {
    ur: "Hajj, ghar, gaadi — jo bhi target ho, yahan se shuru karo",
    en: "Hajj, a home, the next trip — name one and watch it grow",
  },
  empty_goals_subhint: {
    ur: "Choti rakam bhi bara goal banati hai. Aaj se shuru karo.",
    en: "Small amounts compound. Start today, future-you will thank you.",
  },
  empty_goals_cta: { ur: "Goal Banayein", en: "Create Goal" },
  empty_activity_title: { ur: "Khaali safa", en: "Empty page" },
  empty_activity_desc: {
    ur: "Aap kuch karenge, yahan likha jaayega. Saari kahani yahin milegi.",
    en: "Every move you make lands here. Your full money story — always with a receipt.",
  },
  empty_activity_subhint: {
    ur: "Yeh aap ka private log hai — kisi ko nazar nahi aata.",
    en: "Just for you. No one else can see this log.",
  },
  empty_tx_title: { ur: "Khaata khaali hai", en: "A clean ledger" },
  empty_tx_desc: {
    ur: "Pehla kharcha ya amdani add karo — baqi sab khud chal jayega",
    en: "Drop in your first expense or income — we'll handle the rest",
  },
  empty_tx_subhint: {
    ur: "+ dabao, paisa likho, hum baqi ka sambhal lete hain.",
    en: "Tap +, type an amount. We'll ask the smart questions.",
  },
  empty_tx_cta: { ur: "Entry Add Karein", en: "Add Entry" },

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
  nav_groups: { ur: "Group Splits", en: "Group Splits" },
  groups_title: { ur: "Group Splits", en: "Group Splits" },
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
  // Brute-force limiter (supabase-migration-audit-p0-join-abuse-limits.sql):
  // 5 wrong codes in 5 minutes locks join attempts for the rest of the window.
  join_error_rate_limited: {
    ur: "Bohat zyada ghalat code. 5 minute ruk kar dobara koshish karo.",
    en: "Too many wrong codes. Wait 5 minutes and try again.",
  },
  join_error_own_group: {
    ur: "Ye aap ka apna group hai — aap pehle se is mein ho.",
    en: "This is your own group — you’re already in it.",
  },
  join_error_unknown: {
    ur: "Join nahi ho saka. Thori dair baad dobara koshish karo.",
    en: "Couldn’t join. Please try again in a moment.",
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
  group_first_invite_title: { ur: "Pehle kisi ko bulao", en: "Invite someone first" },
  group_first_invite_body: {
    ur: "Split ke liye kam se kam do log chahiye. Apna group code share karo, phir pehla kharcha add karna.",
    en: "A split needs at least two people. Share your group code, then add the first expense together.",
  },
  group_first_invite_cta: { ur: "Group code copy karo", en: "Copy group code" },
  group_code_copied: { ur: "Code copy ho gaya", en: "Code copied" },
  group_code_copied_sub: { ur: "Share karo taake doosre join kar sakein.", en: "Share it so others can join." },
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
  // Audit M8: the import now validates the whole file BEFORE it deletes
  // anything, so every rejection has a specific, honest reason instead of a
  // raw Postgres string in a toast.
  import_err_not_json: {
    ur: "Yeh Hisaab ki backup file nahi lagti. Koi data delete nahi hua.",
    en: "That doesn't look like a Hisaab backup file. Nothing was deleted.",
  },
  import_err_shape: {
    ur: "Backup file adhoori ya kharab hai. Koi data delete nahi hua.",
    en: "The backup file is incomplete or damaged. Nothing was deleted.",
  },
  import_err_version: {
    ur: "Yeh backup Hisaab ke naye version ka hai. Pehle app update karein.",
    en: "This backup was made by a newer version of Hisaab. Update the app first.",
  },
  import_err_bad_collection: {
    ur: "Backup file ka ek hissa kharab hai. Koi data delete nahi hua.",
    en: "One section of the backup file is damaged. Nothing was deleted.",
  },
  import_err_bad_row: {
    ur: "Backup file mein kuch records ki ID nahi hai. Koi data delete nahi hua.",
    en: "Some records in the backup file are missing their ID. Nothing was deleted.",
  },
  import_err_auth: {
    ur: "Restore karne ke liye sign in karna zaroori hai.",
    en: "You need to be signed in to restore a backup.",
  },
  import_err_rolled_back: {
    ur: "Restore mukammal nahi hua. Aap ka purana data wapas laga diya gaya hai.",
    en: "The restore didn't finish. Your previous data has been put back.",
  },
  import_err_rollback_failed: {
    ur: "Restore fail hua aur purana data poori tarah wapas nahi aa saka. App band karke dobara kholein — agar data ab bhi adhoora lage to support se rabta karein.",
    en: "The restore failed and your previous data could not be fully put back. Close and reopen the app — if anything still looks missing, contact support.",
  },
  // Audit UX-09: the Sync Status card is hidden behind VITE_ENABLE_OUTBOX, but
  // its copy was hardcoded English while it was reachable. Localised so the
  // card is shippable the day the outbox actually ships.
  sync_title: { ur: "Sync ki halat", en: "Sync Status" },
  sync_checking: { ur: "Local mirror check ho raha hai…", en: "Checking local mirror…" },
  sync_ready: { ur: "Local mirror tayar hai", en: "Local mirror is ready" },
  sync_queued_n: { ur: "{n} tabdeeliyan sync hone ka intezar kar rahi hain", en: "{n} queued changes waiting to sync" },
  sync_queued_one: { ur: "1 tabdeeli sync hone ka intezar kar rahi hai", en: "1 queued change waiting to sync" },
  sync_queued_label: { ur: "Queue mein offline tabdeeliyan", en: "Queued offline changes" },
  sync_refresh_aria: { ur: "Sync ki halat refresh karo", en: "Refresh sync status" },
  sync_empty: { ur: "Is device par pehli kamyab refresh ke baad sync ki tafseel yahan aayegi.", en: "Sync details will appear after the first successful data refresh on this device." },
  sync_full_refresh: { ur: "Poora refresh", en: "Full refresh" },
  sync_never: { ur: "Abhi tak sync nahi hua", en: "Not synced yet" },
  sync_unknown: { ur: "Maloom nahi", en: "Unknown" },
  sync_tbl_accounts: { ur: "Accounts", en: "Accounts" },
  sync_tbl_transactions: { ur: "Lenden", en: "Transactions" },
  sync_tbl_loans: { ur: "Qarz", en: "Loans" },
  sync_tbl_budgets: { ur: "Budgets", en: "Budgets" },
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
  // Lockout copy for long waits — pin_try_again only reads well in seconds.
  pin_try_again_long: {
    ur: "Bohat zyada ghalat koshishein. {m}m {s}s baad dobara try karein.",
    en: "Too many wrong tries. Try again in {m}m {s}s.",
  },
  pin_locked_note: {
    ur: "Har ghalat koshish par intezaar barhta jayega.",
    en: "Each wrong try makes the wait longer.",
  },
  pin_set_failed: {
    ur: "PIN set nahi ho saka. Yeh device PIN lock support nahi karta.",
    en: "Couldn't set a PIN — this device doesn't support it.",
  },
  pin_verify_failed: {
    ur: "PIN check nahi ho saka. Sign out karke dobara sign in karein.",
    en: "Couldn't check that PIN. Sign out and sign back in.",
  },

  // ── Re-authentication before sensitive account actions (audit SEC-12) ──
  reauth_current_password: { ur: "Mojooda password", en: "Current password" },
  reauth_why: {
    ur: "Tasdeeq ke liye apna mojooda password daalein.",
    en: "Enter your current password to confirm it's you.",
  },
  reauth_required: {
    ur: "Pehle apna mojooda password daalein.",
    en: "Enter your current password first.",
  },
  reauth_wrong_password: {
    ur: "Mojooda password ghalat hai.",
    en: "That current password isn't right.",
  },
  reauth_check_failed: {
    ur: "Password check nahi ho saka. Connection dekh kar dobara koshish karein.",
    en: "Couldn't verify your password. Check your connection and try again.",
  },
  password_updated: { ur: "Password update ho gaya", en: "Password updated" },
  password_update_failed: { ur: "Password update nahi hua", en: "Couldn't update password" },

  // ── Account deletion outcomes ──
  del_account_failed: { ur: "Account delete nahi hua", en: "Could not delete account" },
  del_account_retry: { ur: "Dobara koshish karein.", en: "Please try again." },
  del_account_owned_groups_title: {
    ur: "Pehle apne groups sambhalein",
    en: "Sort out your groups first",
  },
  del_account_owned_groups_body: {
    ur: "In groups mein abhi doosre log hain: {names}. Ownership kisi aur ko dein ya group archive karein, phir account delete karein.",
    en: "These groups still have other members: {names}. Transfer ownership or archive them, then delete your account.",
  },
  del_account_owned_groups_generic: {
    ur: "Aap ke kuch groups mein abhi doosre log hain. Ownership kisi aur ko dein ya woh groups archive karein, phir account delete karein.",
    en: "Some of your groups still have other members. Transfer ownership or archive those groups, then delete your account.",
  },

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
    ur: "Qarz, kharche, kameti, splits — sab ek jaga, sab clear.",
    en: "Loans, expenses, committees, splits — all in one place, all clear.",
  },
  auth_trust: {
    ur: "Koi ads nahi · Aap ka data private · Hamesha free shuru",
    en: "No ads · Your data stays private · Free to start",
  },
  // ── Auth: rotating "what does this app do" headline ──
  // One static prefix + a colored feature word that swaps every few seconds.
  // The sr-only sentence gives assistive tech one coherent phrase, not a flicker.
  auth_headline_prefix: { ur: "Hisaab sambhalta hai aap ke", en: "Hisaab helps you handle" },
  auth_headline_sr: {
    ur: "Hisaab sambhalta hai aap ke qarz, kharche, kameti, splits aur bachat.",
    en: "Hisaab helps you handle loans, expenses, committees, splits and savings.",
  },
  auth_word_loans: { ur: "Qarz", en: "Loans" },
  auth_word_expenses: { ur: "Kharche", en: "Expenses" },
  auth_word_committees: { ur: "Kameti", en: "Committees" },
  auth_word_splits: { ur: "Splits", en: "Splits" },
  auth_word_savings: { ur: "Bachat", en: "Savings" },
  // ── Auth: action-oriented CTA copy ──
  auth_cta_signup: { ur: "Mera Free Account banao", en: "Create my Free Account" },
  auth_cta_login: { ur: "Mujhe log in karao", en: "Log me in" },
  auth_cta_reset: { ur: "Reset link email karo", en: "Email me a reset link" },
  auth_reset_intro: {
    ur: "Apna email daalein, hum reset link bhej denge.",
    en: "Enter your email and we'll send a link to reset your password.",
  },
  auth_first_action_hint: {
    ur: "Naye hain? Free account banayein — bas ek minute.",
    en: "New here? Create your free account — it takes a minute.",
  },
  // ── Auth: pinned field labels + password success ──
  auth_label_email: { ur: "Email", en: "Email" },
  auth_label_password: { ur: "Password", en: "Password" },
  pw_check_done: { ur: "Password mazboot hai", en: "Strong password" },
  // ── Auth: "detour, not dead-end" error copy + inline recovery actions ──
  err_invalid_credentials: {
    ur: "Yeh email aur password match nahi karte. Dobara koshish karein ya reset karein?",
    en: "That email and password don't match. Want to try again, or reset it?",
  },
  err_invalid_credentials_action: { ur: "Password reset karein", en: "Reset password" },
  err_already_registered: {
    ur: "Is email par account pehle se hai. Login karein?",
    en: "You've already got an account with this email. Log in instead?",
  },
  err_already_registered_action: { ur: "Login karein", en: "Log in instead" },
  err_email_not_confirmed: {
    ur: "Bas thori si kasar — email confirm karni hai. Link dobara bhejein?",
    en: "Almost there — your email just needs confirming. Want the link again?",
  },
  err_email_not_confirmed_action: { ur: "Link dobara bhejein", en: "Resend confirmation" },
  err_password_short: {
    ur: "Password thora lamba karein — 8 ya zyada characters.",
    en: "Just make the password a little longer — 8 characters or more.",
  },
  err_password_weak: {
    ur: "Ek harf aur ek number daal kar password mazboot karein.",
    en: "Add a letter and a number to make this password stronger.",
  },
  err_password_action: { ur: "Password theek karein", en: "Fix password" },
  err_security_throttle: {
    ur: "Bas ek lamha — thori jaldi ho gayi. Kuch second baad try karein.",
    en: "Just a moment — that was a bit quick. Try again in a few seconds.",
  },
  err_rate_limit: {
    ur: "Thori der ruk jayein — ek minute baad dobara koshish karein.",
    en: "Whoa, that's a lot of tries. Take a short breather and try again in a minute.",
  },
  err_email_rate_limit: {
    ur: "Kuch emails bhej chuke hain — inbox dekhein ya ek minute baad try karein.",
    en: "We've sent a few emails already — check your inbox, or try again in a minute.",
  },
  err_email_rate_limit_action: { ur: "Inbox dekhein", en: "Check inbox" },
  err_bad_email: {
    ur: "Email thora ghalat lag raha hai — zara check karein?",
    en: "That email looks a little off — mind checking it?",
  },
  err_bad_email_action: { ur: "Email theek karein", en: "Edit email" },
  err_network: {
    ur: "Abhi Hisaab tak nahi pohanch sake. Internet check kar ke dobara try karein.",
    en: "Couldn't reach Hisaab just now. Check your connection and try again.",
  },
  err_deleted_account: {
    ur: "Yeh account delete ho chuka hai. Aap naya account bana sakte hain.",
    en: "This account was deleted. You can start fresh with a new one.",
  },
  err_deleted_account_action: { ur: "Naya account banayein", en: "Create a new account" },
  err_generic: {
    ur: "Kuch masla ho gaya. Ek baar phir koshish karein.",
    en: "Something didn't go through. Give it another try.",
  },
  err_action_try_again: { ur: "Dobara koshish karein", en: "Try again" },
  err_action_dismiss: { ur: "Theek hai", en: "Got it" },
  // Live password checklist (signup)
  pw_check_length: { ur: "Kam se kam 8 characters", en: "At least 8 characters" },
  pw_check_letter: { ur: "Ek harf (a–z)", en: "A letter (a–z)" },
  pw_check_number: { ur: "Ek number (0–9)", en: "A number (0–9)" },
  // "Check your email" screen
  verify_title: { ur: "Apna email check karein", en: "Check your email" },
  verify_body: { ur: "Humne tasdeeq ka link yahan bheja hai:", en: "We sent a confirmation link to" },
  verify_instruction: { ur: "Use khol kar account activate karein, phir wapas aa kar login karein.", en: "Open it to activate your account, then come back and log in." },
  verify_spam: { ur: "Nahi mila? Spam ya promotions folder dekhein.", en: "Don't see it? Check spam or promotions." },
  verify_resend: { ur: "Email dobara bhejein", en: "Resend email" },
  verify_resending: { ur: "Bhej raha hai…", en: "Sending…" },
  verify_resent: { ur: "Bhej diya! Inbox check karein.", en: "Sent — check your inbox." },
  verify_back_login: { ur: "Login par wapas", en: "Back to login" },
  verify_diff_email: { ur: "Doosra email use karein", en: "Use a different email" },
  verify_done_refresh: { ur: "Tasdeeq ho gayi — refresh karein", en: "I've verified — refresh" },
  verify_done_login: { ur: "Tasdeeq ho gayi — login karein", en: "I've verified — log in" },
  verify_confirmed_login: { ur: "Email tasdeeq ho gaya — ab login karein", en: "Email confirmed — log in to continue" },
  verify_diff_account: { ur: "Doosra account use karein", en: "Use a different account" },
  // Auth footer / link copy (kept out of English-only leaks)
  auth_forgot: { ur: "Password bhool gaye?", en: "Forgot password?" },
  auth_remembered: { ur: "Yaad aa gaya?", en: "Remembered it?" },
  auth_back_to_login: { ur: "Login par wapas", en: "Back to Login" },
  auth_no_account: { ur: "Account nahi hai?", en: "Don't have an account?" },
  auth_have_account: { ur: "Pehle se account hai?", en: "Already have an account?" },
  auth_did_you_mean: { ur: "Kya aap ka matlab yeh tha:", en: "Did you mean:" },
  onboard_tagline_sub: {
    ur: "Pakistani expats ke liye banaya — AED ya PKR, dono mein chalta hai.",
    en: "Built for Pakistani expats — works in AED, PKR, and across GCC.",
  },
  onboard_bullet_1: {
    ur: "Dosto ke saath kharche split karo — koi behes nahi",
    en: "Split bills with friends — no awkward math at the end",
  },
  onboard_bullet_2: {
    ur: "Kisne dena hai, kisko dena hai — sab ek nazar mein",
    en: "Who owes you, who you owe — visible at a glance",
  },
  onboard_bullet_3: {
    ur: "Currency conversion ka rate khud track ho jata hai",
    en: "Multi-currency that just works — AED, PKR, SAR and more",
  },
  onboard_bullet_4: {
    ur: "Cash, bank, wallet — har account ka sahi balance, har waqt",
    en: "Cash, bank, wallet — every account stays in sync with reality",
  },
  onboard_start: { ur: "Shuru Karein", en: "Get Started" },
  onboard_footer: {
    ur: "Aapke records ke liye secure sync. Control aapke paas rehta hai.",
    en: "Secure sync for your records. You stay in control of your data.",
  },
  onboard_your_name: { ur: "Pehle apna naam batao", en: "First, your name" },
  onboard_name_sub: {
    ur: "Phir hum sab ka hisaab tumhare naam se rakhenge",
    en: "We'll greet you by name — and keep your ledger personal",
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
  onboard_how_start: { ur: "ab shuru kahan se?", en: "where do we begin?" },
  onboard_how_sub: {
    ur: "Yeh setup ek dafa hai. Sab kuch baad mein badla ja sakta hai.",
    en: "One-time setup. Everything is editable later.",
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
  pwa_install_show_steps: { ur: "Steps Dekho", en: "Show steps" },
  pwa_install_success_title: { ur: "Mubarak ho! Hisaab add ho gaya", en: "Congratulations! Hisaab is installed" },
  pwa_install_success_subtitle: { ur: "App ab aap ki home screen par mil jayegi.", en: "The app has been added to your home screen." },
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
  ltr_repay_linked_notice: {
    ur: "Yeh ek linked loan hai. Ise loan page se settle karein taake doosra shaks confirm kar sake.",
    en: "This is a linked loan. Settle it from the loan page so the other person can confirm.",
  },
  ltr_repay_linked_cta: {
    ur: "Loan page par settle karein",
    en: "Settle on loan page",
  },
  // Audit UX-12: the qist/EMI plan cannot ride along on a linked request —
  // the loan rows are created on both sides only when the other person
  // confirms, and the request table has no instalment columns. Say this
  // instead of rendering the section and quietly discarding it.
  ltr_emi_unavailable_title: {
    ur: "Qist plan yahan set nahi ho sakta",
    en: "Instalment plan isn't available here",
  },
  ltr_emi_unavailable_body: {
    ur: "Yeh entry request ke taur par ja rahi hai. Loan dono taraf tab banega jab doosra shaks confirm karega — is liye qist ka schedule abhi attach nahi ho sakta. Qist chahiye to yeh loan kisi aise contact par likhein jo Hisaab se linked na ho.",
    en: "This entry is going out as a request. The loan is only created on both sides once the other person confirms, so an instalment schedule can't be attached yet. If you need instalments, record this loan against a contact who isn't linked on Hisaab.",
  },
  ltr_emi_kept_warning: {
    ur: "Aap ka qist plan bheja nahi jayega. Aap ne jo values likhi hain woh yahin mehfooz hain — koi non-linked contact chunte hi wapas aa jayengi.",
    en: "Your instalment plan won't be sent. The values you typed are still saved here and come back the moment you pick a contact who isn't linked.",
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
  ltr_tab_info: { ur: "Maloomat", en: "Info" },
  ltr_info_hint: {
    ur: "Subscriptions, budget aur credit card ki yaad-dahaniyaan yahan.",
    en: "Reminders for subscriptions, budgets and credit-card due dates.",
  },
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

  // Which account the settlement money left from (sender-side Phase 2C-B
  // opt-in) — plus honest "record only" notes when no account was involved,
  // so nobody assumes a balance moved. Full-tracker only; simple mode hides
  // account plumbing entirely.
  stl_from_account: { ur: "{account} se paid", en: "Paid from {account}" },
  stl_into_account: { ur: "{account} mein aya", en: "Landed in {account}" },
  stl_account_neutral: { ur: "Account: {account}", en: "Account: {account}" },
  stl_outgoing_no_account: {
    ur: "Sirf record — kisi account se nahi kata",
    en: "Record only — didn't leave any account",
  },
  stl_incoming_no_account: {
    ur: "Sirf record — aap ke kisi account mein nahi aaya. Agar cash mila hai to account khud update karein.",
    en: "Record only — didn't land in any of your accounts. If you received cash, update the account yourself.",
  },
  // Linked LOAN cards wear the same which-account line, loan-flavoured.
  req_from_account: { ur: "{account} se", en: "From {account}" },
  req_into_account: { ur: "{account} mein", en: "Into {account}" },
  req_no_account_note: {
    ur: "Sirf record — koi account balance change nahi hua",
    en: "Record only — no account balance changed",
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
  connect_my_code: { ur: "Aap ka connect code", en: "Your connect code" },
  connect_my_code_desc: { ur: "Ye share karein taake log aap ko add aur connect kar sakein", en: "Share it so people can add and connect with you" },
  connect_share: { ur: "Share", en: "Share" },
  connect_share_text: { ur: "Mujhe Hisaab par add karein — mera code hai", en: "Add me on Hisaab — my code is" },
  connect_code_copied: { ur: "Code copy ho gaya", en: "Code copied" },
  connect_code_copy_failed: { ur: "Copy nahi hua", en: "Couldn't copy" },

  // ── QR connect: show yours, scan theirs ──
  qr_my_title: { ur: "Mera Hisaab QR", en: "My Hisaab QR" },
  qr_my_desc: { ur: "Dusre banday se ye scan karwayein — dono ka connection foran ban jayega.", en: "Have the other person scan this — you'll be connected on the spot." },
  qr_my_hint: { ur: "Camera na chale to neeche wala code likh kar bhi add kiya ja sakta hai.", en: "If the camera won't cooperate, the code below can always be typed in instead." },
  qr_show_cta: { ur: "Mera QR dikhayein", en: "Show my QR" },
  qr_scan_cta: { ur: "Unka QR scan karein", en: "Scan their QR" },
  qr_scan_title: { ur: "Hisaab QR scan karein", en: "Scan a Hisaab QR" },
  qr_scan_hint: { ur: "Unka QR frame ke andar rakhein", en: "Point at their Hisaab QR" },
  qr_scan_starting: { ur: "Camera khul raha hai…", en: "Starting camera…" },
  qr_scan_denied_title: { ur: "Camera ki ijazat nahi hai", en: "Camera access is off" },
  qr_scan_denied_body: { ur: "Phone ki Settings mein Hisaab ko camera ki ijazat dein, ya code haath se likh dein.", en: "Allow camera access for Hisaab in your phone's settings, or just type their code instead." },
  qr_scan_unavailable_title: { ur: "Camera nahi mila", en: "No camera available" },
  qr_scan_unavailable_body: { ur: "Is device par scan nahi ho sakta — unka code likh kar add karein.", en: "Scanning isn't available on this device — type their code instead." },
  qr_scan_type_instead: { ur: "Code likh kar add karein", en: "Type the code instead" },
  qr_scan_wrong_code: { ur: "Ye Hisaab ka QR nahi hai. Unse Hisaab app ka QR khulwayein.", en: "That isn't a Hisaab QR. Ask them to open their Hisaab code." },

  // ── Add contact: the "should I link this person?" question ──
  addc_link_q: { ur: "Kya ye Hisaab par hain?", en: "Are they on Hisaab?" },
  addc_link_q_desc: { ur: "Link karne se dono taraf loan aur settle up confirm hota hai. Ye zaroori nahi — baad mein bhi ho sakta hai.", en: "Linking lets you both confirm loans and settle up. Optional — you can always do it later." },
  addc_link_scan: { ur: "QR scan", en: "Scan QR" },
  addc_link_code: { ur: "Code likhein", en: "Enter code" },
  addc_link_skip: { ur: "Abhi nahi — sirf mere liye save karein", en: "Not now — just save for me" },
  addc_link_found: { ur: "{name} se link hoga", en: "Will connect to {name}" },
  addc_link_change: { ur: "Badlein", en: "Change" },
  addc_cta_plain: { ur: "Contact add karein", en: "Add contact" },
  addc_cta_linked: { ur: "Add karein aur connect karein", en: "Add & connect" },
  addc_link_err_notfound: { ur: "Is code ka koi user nahi mila.", en: "No user with this code." },
  addc_link_err_lookup: { ur: "Code check nahi ho saka. Dobara koshish karein.", en: "Could not look up this code. Try again." },
  addc_link_partial: { ur: "Contact save ho gaya, magar link nahi hua. Unki row par tap kar ke dobara koshish karein.", en: "Contact saved, but linking failed. Tap their row to try again." },

  // ── Connection consent: "X added you — add them back?" ──
  clink_card_title: { ur: "{name} ne aap ko add kiya", en: "{name} added you" },
  clink_card_body: { ur: "Unhon ne aap ka Hisaab code istemal kiya. Add karenge to dono ek doosre ke contacts mein aa jayenge aur loan/settle up share ho sakega.", en: "They used your Hisaab code. Add them back and you'll both appear in each other's contacts, so loans and settle-ups can be shared." },
  clink_add_cta: { ur: "Add karein", en: "Add them" },
  clink_skip_cta: { ur: "Abhi nahi", en: "Not now" },
  clink_added_toast: { ur: "{name} aap ke contacts mein add ho gaye", en: "{name} added to your contacts" },
  clink_declined_toast: { ur: "Add nahi kiya. Unka record aap ke paas nahi banega.", en: "Not added. Nothing was saved to your contacts." },
  clink_err: { ur: "Ye ho nahi saka. Dobara koshish karein.", en: "That didn't work. Try again." },
  clink_waiting: { ur: "{name} ke add karne ka intezar hai", en: "Waiting for {name} to add you back" },
  clink_waiting_desc: { ur: "Aap unhein apne khaate mein rakh sakte hain aur record bhej sakte hain. Jab woh add karenge, aap unke contacts mein bhi aa jayenge.", en: "You can keep them in your ledger and send them records now. Once they add you back, you'll appear in their contacts too." },
  clink_mutual: { ur: "Dono taraf se connected", en: "Connected both ways" },

  // ── Link failures (audit 2026-09 C6): every status link_contact_by_code /
  //    unlink_contact_profile can return. Statuses map to keys in
  //    src/lib/contactLinkStatus.ts — keep the two in step. ──
  clink_err_no_match: { ur: "Is code ka koi user nahi mila. Code dobara check karein.", en: "No user with this code. Double-check it and try again." },
  clink_err_invalid_code: { ur: "Ye code theek nahi lag raha. Hisaab code 6 characters ka hota hai, jaise HSB-AB12CD.", en: "That code doesn’t look right. A Hisaab code is 6 characters, like HSB-AB12CD." },
  clink_err_rate_limited: { ur: "Bohat zyada code check ho chuke. {minutes} minute baad dobara koshish karein.", en: "Too many code lookups. Try again in {minutes} minutes." },
  clink_err_already_linked: { ur: "Ye contact pehle se kisi aur Hisaab user se juda hua hai. Pehle unlink karein, phir naya code lagayein.", en: "This contact is already linked to a different Hisaab user. Unlink first, then use the new code." },
  clink_err_self: { ur: "Ye aap ka apna code hai — apne aap ko add nahi kar sakte.", en: "That’s your own code — you can’t link yourself." },
  clink_err_archived: { ur: "Ye contact hataya ja chuka hai. Pehle usay wapas layein, phir link karein.", en: "This contact was removed. Restore it first, then link." },
  clink_err_contact_missing: { ur: "Ye contact nahi mila. Contacts refresh kar ke dobara koshish karein.", en: "Couldn’t find this contact. Refresh Contacts and try again." },
  clink_err_auth: { ur: "Pehle sign in karein.", en: "You need to sign in first." },
  clink_err_network: { ur: "Network nahi mila. Connection check kar ke dobara koshish karein.", en: "Can’t reach the server. Check your connection and try again." },
  // Fallback for any caller that still tries to write the link column itself.
  // Both real paths (code and phone discovery) have a server RPC now, so this
  // should not be reachable from the app — kept as the honest answer if it is.
  clink_err_code_required: { ur: "Link ke liye ab unka Hisaab code chahiye. Un se code ya QR maang kar dobara koshish karein.", en: "Linking now needs their Hisaab code. Ask them for their code or QR, then try again." },
  clink_err_unlink: { ur: "Unlink nahi ho saka. Dobara koshish karein.", en: "Could not unlink this contact. Try again." },
  clink_err_unknown: { ur: "Link nahi ho saka. Thori dair baad dobara koshish karein.", en: "Couldn’t link. Please try again in a moment." },
  // Discovery-path wording for two statuses whose code-path copy would be a
  // lie: there is no code to re-check, and the throttle is the phone budget.
  // link_contact_by_discovery re-checks the number AND their opt-in at link
  // time, so a badge that was true an hour ago can honestly fail now.
  clink_err_discovery_no_match: { ur: "Ye number ab un ke Hisaab account se match nahi karta — number badal gaya ho ga ya unhon ne discovery band kar di hai. Un se Hisaab code maang kar link karein.", en: "That number no longer matches their Hisaab account — they may have changed it or turned discovery off. Ask them for their Hisaab code instead." },
  clink_err_discovery_rate_limited: { ur: "Bohat zyada number check ho chuke. {minutes} minute baad dobara koshish karein.", en: "Too many number lookups. Try again in {minutes} minutes." },

  // ── Phone discovery (opt-in, no address-book access) ──
  disc_badge: { ur: "Hisaab User", en: "Hisaab User" },
  disc_found: { ur: "Ye number Hisaab par hai — {name}", en: "This number is on Hisaab — {name}" },
  // Security audit 2026-09 (SEC-09): phone numbers are self-claimed — nobody
  // verifies ownership — so a discovery hit must never wear the verified seal.
  // This caption says plainly what the match does and doesn't prove.
  disc_unverified_note: {
    ur: "Number match hua hai — tasdeeq shuda nahi. Naam is account ne khud rakha hai; paisa record karne se pehle khud tasdeeq kar lein.",
    en: "Number matched — not verified. This name is chosen by that account; confirm with them before recording money.",
  },
  disc_link_cta: { ur: "Link karein", en: "Link them" },
  disc_my_phone_title: { ur: "Mera phone number", en: "My phone number" },
  disc_my_phone_desc: { ur: "Jinke paas aap ka number save hai, unhein Hisaab par aap mil jayenge. Number kisi ko dikhaya nahi jata — sirf match kiya jata hai.", en: "People who already have your number saved can find you on Hisaab. Your number is never shown to anyone — only matched." },
  disc_my_phone_toggle: { ur: "Mere number se log mujhe dhoond sakein", en: "Let people with my number find me" },
  disc_my_phone_placeholder: { ur: "+971 50 123 4567", en: "+971 50 123 4567" },
  disc_my_phone_confirm: { ur: "Aise save hoga: {number}", en: "Will be saved as {number}" },
  disc_my_phone_invalid: { ur: "Ye number samajh nahi aya. Country code ke sath likhein, jaise +971…", en: "Couldn't read that number. Include the country code, e.g. +971…" },
  disc_my_phone_saved: { ur: "Number save ho gaya", en: "Number saved" },
  disc_my_phone_removed: { ur: "Number hata diya", en: "Number removed" },
  disc_my_phone_none: { ur: "Add nahi kiya", en: "Not added" },
  disc_my_phone_hidden: { ur: "Save hai, magar koi aap ko dhoond nahi sakta", en: "Saved, but nobody can find you" },

  // ── Push notifications ──
  push_title: { ur: "Turant notifications", en: "Instant notifications" },
  push_desc: { ur: "Koi loan bhejay ya aap ko add kare to phone par foran pata chale — app band ho tab bhi.", en: "Get told the moment someone sends you a loan or adds you — even when the app is closed." },
  contact_whatsapp: { ur: "WhatsApp number", en: "WhatsApp number" },
  contact_whatsapp_none: { ur: "Add nahi kiya", en: "Not added" },
  contact_whatsapp_add: { ur: "Add", en: "Add" },
  contact_whatsapp_edit: { ur: "Edit", en: "Edit" },
  contact_whatsapp_saved: { ur: "WhatsApp number save ho gaya", en: "WhatsApp number saved" },
  contact_whatsapp_removed: { ur: "Number hata diya", en: "Number removed" },
  contact_unlink_confirm_title: { ur: "{name} ko unlink karein?", en: "Unlink {name}?" },
  contact_unlink_confirm_body: { ur: "Aage ke loans aur splits unke sath sync hona band ho jayenge. Dobara joṛne ke liye unka code phir chahiye hoga.", en: "Future loans and splits will stop syncing to them. To reconnect you'll need their code again." },
  contact_unlink_confirm_cta: { ur: "Unlink", en: "Unlink" },
  contact_sync_confirm_title: { ur: "Apne shared records {name} ko bhejein?", en: "Send your shared records to {name}?" },
  contact_sync_confirm_body: { ur: "Har purana shared loan unke Inbox mein accept ya decline ke liye aayega. Ise ek sath wapas nahi liya ja sakta.", en: "Each shared past loan appears in their Inbox to accept or decline. It can't be un-sent as a batch." },
  contact_sync_confirm_cta: { ur: "Confirmation ke liye bhejein", en: "Send for confirmation" },
  contacts_empty: { ur: "Abhi koi contact nahi.", en: "No contacts yet." },
  contacts_link_help: {
    ur: "Dusra person say kahain wo Hisaab use kare aur apna code ap kay sath share kare. Phir yahan link karne ke baad app connect ho jaogy aur loan/split approvals bheje ja sakte hain.",
    en: "The other person must also use Hisaab and share their code. After linking them here, loan and split approvals can be sent.",
  },
  edit_entry_title: { ur: "Entry Edit Karein", en: "Edit Entry" },

  // ── Phase H1: Unified vocabulary (display-side action labels) ──
  // Past-tense, direction-aware labels used wherever an entry is read back
  // (TransactionItem, ContactDetailSheet history, EditTransactionModal
  // header, RepaymentModal title). The {amount}/{person}/{src}/{dst}/{goal}
  // placeholders are resolved by getActionLabel in src/lib/transactionLabel.
  action_spent: { ur: "Kharcha kiya", en: "You spent" },
  action_received: { ur: "Aaye", en: "You received" },
  action_moved: { ur: "Move kiya", en: "You moved" },
  action_gave: { ur: "Diye {person} ko", en: "You gave to {person}" },
  action_gave_noperson: { ur: "Diye", en: "You gave" },
  action_borrowed: { ur: "Liye {person} se", en: "You borrowed from {person}" },
  action_borrowed_noperson: { ur: "Liye", en: "You borrowed" },
  action_they_paid_back: {
    ur: "{person} ne wapas diye",
    en: "{person} paid you back",
  },
  action_they_paid_back_noperson: {
    ur: "Wapas mil gaye",
    en: "They paid you back",
  },
  action_i_paid_back: {
    ur: "{person} ko wapas diye",
    en: "You paid {person} back",
  },
  action_i_paid_back_noperson: { ur: "Wapas de diye", en: "You paid back" },
  action_saved_goal: { ur: "Bachat ki {goal} ke liye", en: "You saved toward {goal}" },
  action_saved_goal_nogoal: { ur: "Bachat ki", en: "You saved" },
  action_opening_balance: { ur: "Opening balance", en: "Opening balance" },

  // RepaymentModal — direction-aware titles. The current generic
  // "Make Repayment - {name}" is wrong in tone when the OTHER person is
  // the one paying (loan_given being settled).
  repay_they_paying_title: {
    ur: "{person} aap ko wapas day raha hai",
    en: "{person} is paying you back",
  },
  repay_you_paying_title: {
    ur: "Aap {person} ko wapas day rahe hain",
    en: "You're paying {person} back",
  },

  // i18n leak fixes — these strings were previously hardcoded in
  // English-mode code paths and surfaced Urdu transliteration to EN users.
  toast_error_generic: {
    ur: "Kuch galat ho gaya",
    en: "Something went wrong. Your money was not moved.",
  },
  quick_note_placeholder: {
    ur: "Koi detail likho...",
    en: "Add a note (optional)",
  },
  account_not_found: { ur: "Account nahi mila", en: "Account not found" },

  // Loan card-picker labels (replaces 4 native selects in QuickEntry).
  pick_loan: { ur: "Kaun sa qarz?", en: "Which loan?" },
  pick_account: { ur: "Kaun sa account?", en: "Which account?" },
  pick_goal: { ur: "Kaun sa goal?", en: "Which goal?" },

  // LoanDetailPage — unified payment CTA (replaces split
  // Repay/Mark paid/Record Settlement buttons).
  loan_record_payment: { ur: "Payment Record Karo", en: "Record payment" },
  loan_record_payment_linked_sub: {
    ur: "{person} ko confirm karna hoga",
    en: "{person} will need to confirm",
  },
  loan_record_payment_local_sub: {
    ur: "Sirf aap ke records main",
    en: "Saves locally",
  },

  // AccountDetailPage — two new tiles for the expanded quick-action grid.
  acct_action_person: { ur: "Kisi ke sath", en: "With someone" },
  acct_action_group: { ur: "Group main", en: "Split group" },
  acct_action_pay_card: { ur: "Card ka bill bharo", en: "Pay card bill" },

  // ── Phase H2: Money-safety guards (Android prod hardening) ──
  // User-facing errors when amount validation rejects a save. These
  // surface in toast subtitles, so keep them under ~80 chars.
  err_overpayment: {
    ur: "Yeh amount baqi qarz se zyada hai. Sirf {remaining} baqi hai.",
    en: "Amount exceeds the remaining loan. Only {remaining} left.",
  },
  // Loan optimistic-lock outcomes (audit C10). Thrown by loanStore when the
  // apply_loan_remaining_delta RPC refuses a stale write — surfaced as a toast
  // subtitle, so keep them short.
  err_loan_changed_elsewhere: {
    ur: "Yeh qarz abhi kisi aur device par badla hai. Refresh karke dobara likhein.",
    en: "This loan just changed on another device. Refresh and enter it again.",
  },
  err_loan_gone: {
    ur: "Yeh qarz ab mojood nahi — shayad kisi aur device par delete hua hai.",
    en: "This loan no longer exists — it may have been deleted on another device.",
  },
  err_repayment_amount_invalid: {
    ur: "Payment ki raqam sahi nahi. Zero se zyada amount likhein.",
    en: "That payment amount isn't valid. Enter an amount greater than zero.",
  },
  // Store-level money bounds (audit 12-qa-review V-1/F-9). These fire BEFORE
  // any balance moves, in both app modes, for amounts the per-form guards
  // missed — a NaN from a parse, a pasted negative, an absurd magnitude.
  err_money_amount_invalid: {
    ur: "Raqam sahi nahi. Sirf number likhein.",
    en: "That amount isn't valid. Enter a number.",
  },
  err_money_amount_not_positive: {
    ur: "Raqam zero se zyada honi chahiye.",
    en: "The amount must be greater than zero.",
  },
  err_money_amount_negative: {
    ur: "Raqam minus mein nahi ho sakti.",
    en: "The amount can't be negative.",
  },
  err_money_amount_too_large: {
    ur: "Yeh raqam bohot zyada hai — dobara check karein.",
    en: "That amount is too large — please double-check it.",
  },
  // Client-side mirror of the server's GROUP_SPLITS_DO_NOT_SUM trigger.
  err_group_splits_mismatch: {
    ur: "Hisson ka total {splits} ban raha hai, magar kharcha {amount} hai. Dono barabar hone chahiye.",
    en: "The shares add up to {splits} but the expense is {amount}. They have to match.",
  },
  err_rate_too_low: {
    ur: "Conversion rate bohot kam hai. Phir se check karein.",
    en: "Conversion rate is too low. Please check and try again.",
  },
  err_rate_too_high: {
    ur: "Conversion rate bohot zyada hai. Phir se check karein.",
    en: "Conversion rate is too high. Please check and try again.",
  },
  // Loan confirmation step before commit — restates what's about to happen.
  confirm_repayment_title: {
    ur: "Confirm karein",
    en: "Confirm payment",
  },
  confirm_repayment_body_received: {
    ur: "{person} ne aap ko {amount} wapas diya. Yeh sahi hai?",
    en: "{person} paid you {amount} back. Is this correct?",
  },
  confirm_repayment_body_paid: {
    ur: "Aap {person} ko {amount} wapas day rahe hain. Yeh sahi hai?",
    en: "You're paying {person} {amount} back. Is this correct?",
  },
  confirm_repayment_yes: { ur: "Haan, save karo", en: "Yes, save" },
  confirm_repayment_no: { ur: "Wapas jaaiye", en: "Go back" },

  // Locked contact / account chips — shown when a preset has locked the
  // value so the user knows it's intentional, not broken.
  locked_to_contact: { ur: "Sirf {name} ke liye", en: "Locked to {name}" },
  locked_to_account: { ur: "Sirf {name} se", en: "Locked to {name}" },

  // Password policy hint — surfaced inline on signup + change.
  password_hint_12: {
    ur: "Kam se kam 8 chars. Harf aur number dono shamil ho.",
    en: "At least 8 characters, with letters and numbers.",
  },
  password_too_short: {
    ur: "Password chhota hai. 8+ chars use karein.",
    en: "A bit short — use 8 or more characters.",
  },
  password_missing_complexity: {
    ur: "Password mein harf aur number dono honay chahiye.",
    en: "Password must include both letters and numbers.",
  },

  // ── Phase H3: Splits-only mode + Inbox polish ──
  // Inbox empty state — replaces the generic "No pending requests right now"
  // with a friendly, illustrated explanation of what the inbox is for.
  inbox_empty_incoming_title: {
    ur: "Inbox khali hai",
    en: "Nothing waiting",
  },
  inbox_empty_incoming_desc: {
    ur: "Jab koi linked contact aap ko loan ya settlement bhejega, yahan dikhega.",
    en: "When a linked contact sends you a loan or settlement to confirm, it'll show up here.",
  },
  inbox_empty_info_title: {
    ur: "Sab control mein",
    en: "All caught up",
  },
  inbox_empty_info_desc: {
    ur: "Koi budget alert, subscription renewal ya credit card due nahi — sab theek hai.",
    en: "No budget alerts, upcoming renewals or credit-card dates right now. You're all set.",
  },
  inbox_empty_outgoing_title: {
    ur: "Sab clear hai",
    en: "All clear",
  },
  inbox_empty_outgoing_desc: {
    ur: "Jo requests aap ne bheji hain, woh confirm hotay hi yahan se hat jati hain.",
    en: "Anything you've sent waiting on confirmation lives here. You're caught up.",
  },

  // Splits-only home page tiles — quick links to the surfaces that exist
  // in this mode (no accounts/transactions).
  splits_home_contacts: { ur: "Aap ke Contacts", en: "Your contacts" },
  splits_home_contacts_sub: { ur: "Link aur trust", en: "Link and trust" },
  splits_home_activity: { ur: "Recent Activity", en: "Recent activity" },
  splits_home_activity_sub: { ur: "Sab kuch ek nazar mein", en: "Everything at a glance" },
  splits_home_new_iou: { ur: "Naya Hisaab", en: "New IOU" },
  splits_home_new_iou_sub: { ur: "Diya, liya, ya wapsi", en: "Gave, borrowed, paid back" },
  splits_home_new_group: { ur: "Naya Group", en: "New group" },
  splits_home_new_group_sub: { ur: "Friends ke sath split", en: "Split with friends" },

  // Time-of-day greetings. English stays neutral; Roman Urdu keeps the
  // warm/Islamic greetings. Selected via the active language by useT().
  greet_morning: { ur: "Subah Bakhair", en: "Good Morning" },
  greet_afternoon: { ur: "Assalam o Alaikum", en: "Good Afternoon" },
  greet_evening: { ur: "Shaam Bakhair", en: "Good Evening" },
  greet_night: { ur: "Shab Bakhair", en: "Good Night" },
  greet_hello: { ur: "Salaam", en: "Hello" },

  // Multi-loan repayment allocation
  alloc_title: { ur: "Payment baantein", en: "Record a payment" },
  alloc_intro: {
    ur: "Ek amount likhein — hum ise neeche diye loans par laga denge.",
    en: "Enter one amount — we'll spread it across these loans for you.",
  },
  alloc_lump_label: { ur: "Kitna paisa lagana hai", en: "Amount to apply" },
  alloc_strategy_label: { ur: "Kaise lagayein", en: "How to apply it" },
  alloc_smallest: { ur: "Chhote pehle", en: "Clear smallest first" },
  alloc_largest: { ur: "Bade pehle", en: "Largest first" },
  alloc_oldest: { ur: "Purane pehle", en: "Oldest first" },
  alloc_manual: { ur: "Khud chunein", en: "Choose per loan" },
  alloc_account_label: { ur: "Account", en: "From / to account" },
  alloc_preview: { ur: "Yeh laga", en: "This clears" },
  alloc_cleared: { ur: "clear", en: "cleared" },
  alloc_leftover: { ur: "bacha hua", en: "left over (not applied)" },
  alloc_apply: { ur: "Payment lagayein", en: "Apply payment" },
  alloc_applying: { ur: "Lag raha hai…", en: "Applying…" },
  alloc_done: { ur: "Payment lag gayi", en: "Payment applied" },
  alloc_over: { ur: "Total remaining se zyada nahi ho sakta.", en: "Can't apply more than the total remaining." },
  alloc_linked_note: {
    ur: "Linked loans yahan shamil nahi — unhein loan page se settle karein.",
    en: "Linked loans aren't included here — settle those from their loan page.",
  },
  alloc_partial_title: { ur: "{done} of {total} lag gaye", en: "Applied to {done} of {total}" },

  // ── Consolidated repayment: person-first Quick Entry ──
  // One lump entry settles across a person's loans (oldest first) instead of
  // forcing one entry per loan line.
  qe_group_n_loans: { ur: "{n} qarz", en: "{n} loans" },
  qe_group_pick_specific: { ur: "Koi aik qarz chunein", en: "Choose a specific loan" },
  qe_group_all_loans: { ur: "Saare qarz (purane pehle)", en: "All their loans (oldest first)" },
  qe_group_alloc_note: { ur: "Purane qarz pehle utarenge", en: "Oldest loans clear first" },
  qe_group_done_desc: { ur: "{amount} — {n} qarz par lag gaya", en: "{amount} applied across {n} loans" },
  qe_group_cleared_count: { ur: "{n} qarz clear ho gaye", en: "{n} cleared" },
  err_overpayment_group: {
    ur: "{person} ka total baqi sirf {remaining} hai.",
    en: "More than {person}'s total remaining. Only {remaining} left.",
  },
  err_batch_balance_short: {
    ur: "Account mein poori payment ke liye raqam kam hai.",
    en: "Not enough in this account for the whole payment.",
  },
  repay_overflow_body: {
    ur: "{person} ke {n} aur active qarz hain ({total} baqi). Extra unpar lagayein?",
    en: "{person} has {n} more active loan(s) ({total} remaining). Spread the extra across them?",
  },
  repay_overflow_cta: { ur: "Sab qarz par baantein", en: "Spread across their loans" },
  repay_pay_all_cta: { ur: "Sab {n} qarz ek saath utarein", en: "Pay across all {n} loans" },

  // ── Bulk linked settlement: one lump → one settlement request per loan ──
  stl_bulk_title: { ur: "Sab qarz ka settlement", en: "Settle across all loans" },
  stl_bulk_intro: {
    ur: "Ek amount likhein — har qarz ke liye alag settlement request banegi. {name} confirm karenge to dono taraf ka hisaab update hoga.",
    en: "Enter one amount — it splits into a settlement request per loan. Once {name} confirms, both sides' books update.",
  },
  stl_bulk_send: { ur: "{n} requests bhejein", en: "Send {n} requests" },
  stl_bulk_sent_title: { ur: "Requests bhej di gayin", en: "Requests sent" },
  stl_bulk_sent_subtitle: {
    ur: "{name} confirm karenge to hisaab update ho jayega.",
    en: "Balances update as {name} confirms them.",
  },
  stl_bulk_partial: { ur: "{done} of {total} bheji gayin", en: "Sent {done} of {total}" },
  stl_bulk_clears: { ur: "poora settle", en: "settles fully" },
  stl_bulk_confirm_body: {
    ur: "{name} ko {n} settlement requests jayengi — total {amount}. Har request unke confirm karne par lagegi.",
    en: "{name} will receive {n} settlement requests totalling {amount}. Each applies once they confirm it.",
  },
  stl_bulk_confirm_note: {
    ur: "Yeh requests hain — jab tak {name} confirm na karein, hisaab change nahi hota.",
    en: "These are requests — nothing changes until {name} confirms each one.",
  },
  stl_bulk_pending_note: {
    ur: "Jis qarz par pehle se request pending hai, woh yahan shamil nahi.",
    en: "Loans that already have a pending request aren't included.",
  },
  loan_group_settled_label: { ur: "Mukammal settle 🎉", en: "All settled 🎉" },

  // ── Per-type account pages: credit-card-native actions ──
  acct_action_card_spend: { ur: "Card se kharch", en: "Spend on card" },
  acct_action_card_settings: { ur: "Limit / due date", en: "Limit & due date" },
  cc_settings_title: { ur: "Card ki settings", en: "Card settings" },
  cc_settings_limit: { ur: "Credit limit", en: "Credit limit" },
  cc_settings_due: { ur: "Bill due day (1–31)", en: "Bill due day (1–31)" },
  cc_settings_saved: { ur: "Card settings save ho gayin", en: "Card settings saved" },

  // ── UX pass: bilingual copy for confirmations, errors, status & validation ──
  // Cross-user money confirmations (were English-only)
  confirm_send_title: { ur: "{name} ko {amount} bhejein?", en: "Send {amount} to {name}?" },
  confirm_send_body: { ur: "{approx}Yeh {name} ko bhi dikhega aur accept hone ke baad badla nahi ja sakta.", en: "{approx}This is mirrored to {name} and can't be edited after they accept." },
  confirm_send_cta: { ur: "Request bhejo", en: "Send request" },
  confirm_accept_title: { ur: "{amount} accept karein?", en: "Accept {amount}?" },
  confirm_accept_body: { ur: "{approx}Yeh dono taraf shared loan banayega. Iske baad sirf settle ho sakta hai, edit nahi.", en: "{approx}This adds a shared loan to both ledgers. After this it can only be settled, not edited." },
  confirm_settle_title: { ur: "{amount} ki settlement confirm karein?", en: "Confirm settlement of {amount}?" },
  confirm_settle_body: { ur: "Yeh dono taraf ka hisaab barabar kar dega. Wapas nahi ho sakta.", en: "This clears the matching balance on both sides. It can't be undone." },
  // Full-tracker accept sheet: which account did the money actually touch?
  // "Record only" stays the default — an account effect must be a conscious
  // choice, mirroring the sender-side Phase 2C-B opt-in.
  acpt_where_in: { ur: "Paisa kis account mein aya?", en: "Which account did the money land in?" },
  acpt_where_out: { ur: "Paisa kis account se gaya?", en: "Which account did the money leave from?" },
  acpt_where_neutral: { ur: "Kis account par lagana hai?", en: "Which account should this apply to?" },
  acpt_record_only: { ur: "Sirf record — koi account nahi", en: "Record only — no account" },
  acpt_record_only_hint: { ur: "Aap ke balances change nahi honge.", en: "Your balances stay untouched." },
  acpt_no_eligible: {
    ur: "Koi {currency} account nahi — sirf record hoga, balance nahi badlega.",
    en: "No {currency} account yet — this will be recorded without touching balances.",
  },
  acpt_balance_effect: { ur: "{account} mein {delta} ka farq aayega.", en: "This will change {account} by {delta}." },
  // Destructive confirmations
  del_account_body: { ur: "Yeh account aur uski history hamesha ke liye delete kar dega. Wapas nahi hoga.", en: "This permanently deletes the account and its history. This can't be undone." },
  del_group_body: { ur: "Sab kharche, settlements aur members ke links sab ke liye hat jayenge. Wapas nahi hoga.", en: "All expenses, settlements and member links are removed for everyone. This can't be undone." },
  del_budget_body: { ur: "Jab chahein dobara bana sakte hain.", en: "You can recreate it any time." },
  del_tx_title: { ur: "Yeh entry delete karein?", en: "Delete this entry?" },
  del_tx_body: { ur: "Iska balance par asar ulat jayega.", en: "The balance change will be reversed." },
  del_contact_body: { ur: "Yeh contact aur uska local record hat jayega.", en: "This removes the contact and its local record." },
  // Error recovery (replace raw err.message)
  // NOTE: Hisaab has no working offline write queue (the outbox runner is
  // inert behind VITE_ENABLE_OUTBOX), so this must NOT promise a later save.
  err_offline: { ur: "Aap offline hain — yeh entry save NAHI hui. Internet aane par dobara karein.", en: "You're offline — this entry was not saved. Try again once you're connected." },
  err_could_not_save: { ur: "Save nahi hua — aapka paisa waise ka waisa hai. Dobara koshish karein.", en: "Couldn't save that — your money wasn't touched. Try again." },
  // Shared error/hint defaults
  err_page_title: { ur: "Yeh load nahi hua", en: "Couldn't load this" },
  err_page_msg: { ur: "Apna connection check karke dobara koshish karein.", en: "Check your connection and try again." },
  err_retry: { ur: "Dobara koshish", en: "Try again" },
  hint_current_status: { ur: "Abhi ki soorat-e-haal", en: "Current status" },
  err_insufficient: { ur: "{account} mein sirf {available} hain — yeh {amount} se kam hai.", en: "{account} only has {available} — that's less than {amount}." },
  // Spending warning (was hardcoded Roman Urdu, leaked to English users)
  spend_warning_remember: { ur: "Yaad rahe: {title} aa raha hai", en: "Heads up: {title} is coming up" },
  spend_warning_body: { ur: "{title} ke liye jald {amount} chahiye honge.", en: "You'll need {amount} for {title} soon." },
  spend_warning_confirm_q: { ur: "Phir bhi kharch karein?", en: "Spend anyway?" },
  // Field-specific validation
  val_need_amount: { ur: "Pehle amount likho", en: "Enter an amount first" },
  val_need_name: { ur: "Ek naam do", en: "Give it a name" },
  val_pick_account: { ur: "Account chuno", en: "Choose an account" },
  val_emi_incomplete: { ur: "Instalments aur start date dono bharein.", en: "Add the number of instalments and a start date." },
  val_balance_invalid: { ur: "Opening balance negative ya ghalat nahi ho sakta.", en: "Opening balance can't be negative." },
  contact_dup_warning: { ur: "Aap ke pass pehle se “{name}” naam ka contact hai. Dusra banane se loan matching confuse ho sakti hai.", en: "You already have a contact named “{name}”. Adding another can make loan matching ambiguous." },
  val_pick_member: { ur: "Kam se kam ek banda chuno jiske sath bantna hai", en: "Pick at least one person to split with" },
  val_shares_zero: { ur: "Kam se kam ek banday ko hissa do", en: "Give at least one person a share" },
  // Repayment CTA (direction-aware)
  repay_record_received: { ur: "Wapsi record karo", en: "Record received" },
  repay_record_paid: { ur: "Adaigi record karo", en: "Record payment" },
  // At-a-glance status labels
  status_overdue: { ur: "Overdue", en: "Overdue" },
  status_due_soon: { ur: "Jald due", en: "Due soon" },
  loan_age_today: { ur: "Aaj", en: "Today" },
  loan_age_days: { ur: "{n} din", en: "{n}d" },
  status_settled: { ur: "Settled", en: "Settled" },
  status_unsettled: { ur: "Baqaya", en: "Unsettled" },
  status_pending_reply: { ur: "Jawab ka intezar", en: "Awaiting reply" },
  // Search
  search_scope_placeholder: { ur: "Transactions, loans, groups dhoondein...", en: "Search transactions, loans, groups..." },
  search_covers: { ur: "Search transactions, loans aur group expenses ko cover karta hai.", en: "Search covers transactions, loans and group expenses." },
  // Generic dialog actions
  cancel: { ur: "Cancel", en: "Cancel" },
  save: { ur: "Save karein", en: "Save" },
  confirm_generic: { ur: "Theek hai", en: "Confirm" },
  err_contact_support: { ur: "Support se rabta karein", en: "Contact support" },
  cc_due_in: { ur: "{n} din mein due", en: "Due in {n}d" },
  cc_due_today: { ur: "Aaj due", en: "Due today" },
  cc_used_pct: { ur: "{n}% istemal", en: "{n}% used" },
  acct_cash_owed: { ur: "{cash} cash · {owed} dena", en: "{cash} cash · {owed} owed" },

  // ── Savings goals (simple tracker + optional deadline) ──
  goal_intro: { ur: "Kisi cheez ke liye paise alag rakho aur progress dekho. Yahan paise dalna sirf track karta hai — accounts ke darmiyan paisa move nahi karta.", en: "Set aside money for something and watch it grow. Adding money here just tracks your progress — it doesn't move money between your accounts." },
  goal_target_date: { ur: "Tareekh (optional)", en: "Target date (optional)" },
  goal_target_date_help: { ur: "Tareekh dalo to Hisaab bata dega har mah kitna bachana hai.", en: "Add a date and Hisaab will suggest how much to save each month." },
  goal_add_money: { ur: "Paise dalo", en: "Add money" },
  goal_add_to: { ur: "{title} mein dalo", en: "Add to {title}" },
  goal_take_out: { ur: "Nikaalo", en: "Take out" },
  goal_track_note: { ur: "Yeh sirf aapki bachat track karta hai — accounts ke darmiyan paisa move nahi karta.", en: "This just tracks your saving — it won't move money between your accounts." },
  goal_by_date: { ur: "{date} tak", en: "By {date}" },
  goal_save_monthly: { ur: "~{amount}/mah bachao", en: "save ~{amount}/mo" },
  goal_on_track: { ur: "Theek ja raha", en: "On track" },
  goal_behind: { ur: "Peeche", en: "Behind" },
  goal_catch_up: { ur: "Track par aane ke liye is mahine {amount} rakho", en: "Set aside {amount} this month to catch up" },
  goal_milestone: { ur: "{pct}% ho gaya — shabash! \u{1F389}", en: "{pct}% there — keep going! \u{1F389}" },
  goal_reached: { ur: "Goal pura ho gaya! \u{1F389}", en: "Goal reached! \u{1F389}" },
  goal_locked_title: { ur: "Abhi nikalna hai?", en: "Take out early?" },
  goal_locked_body: { ur: "Ye goal {date} tak ke liye hai. Phir bhi nikalna chahte hain?", en: "This goal runs until {date}. Take money out anyway?" },
  goal_date_passed: { ur: "Tareekh guzar gayi", en: "Date passed" },
  goal_amount_label: { ur: "Kitne paise?", en: "How much?" },

  // ── UX localization pass ──
  // Generic actions / nav
  action_view: { ur: "Dekho", en: "View" },
  nav_add: { ur: "Add", en: "Add" },
  not_now: { ur: "Abhi nahin", en: "Not now" },
  label_you: { ur: "Aap", en: "You" },
  // Groups list / card
  group_to_settle: { ur: "{n} settle karne hain", en: "{n} to settle" },
  // Global search
  search_recent: { ur: "Haal hi mein", en: "Recent" },
  search_no_matches: { ur: "“{q}” ke liye kuch nahin mila.", en: "No matches for “{q}”." },
  // Accounts
  acct_set_limit: { ur: "Limit set karo", en: "Set limit" },
  acct_available: { ur: "available", en: "available" },
  acct_owe: { ur: "Dena hai {amount}", en: "Owe {amount}" },
  acct_assets: { ur: "Assets +{amount}", en: "Assets +{amount}" },
  acct_owe_total: { ur: "Dena hai -{amount}", en: "Owe -{amount}" },
  // Budgets
  budget_over: { ur: "{n} over", en: "{n} over" },
  budget_near: { ur: "{n} limit ke kareeb", en: "{n} near limit" },
  budget_on_track: { ur: "Sab theek", en: "All on track" },
  budget_left_title: { ur: "Is mahine kharch karne ko bacha", en: "Left to spend this month" },
  budget_spent_of: { ur: "{spent} / {total} use hua", en: "{spent} of {total} used" },

  // Getting-started first-win card
  gs_title: { ur: "Chalein, shuru karein", en: "Let's get you set up" },
  gs_subtitle: { ur: "Do chhote step — phir aap tayyar hain", en: "Two quick steps and you're ready" },
  gs_step_account: { ur: "Pehla account banayein", en: "Add your first account" },
  gs_step_entry: { ur: "Pehli entry add karein", en: "Log your first entry" },
  gs_cta_add: { ur: "Banayein", en: "Add" },
  gs_cta_log: { ur: "Add karein", en: "Log" },
  gs_progress: { ur: "{done} / {total}", en: "{done} of {total}" },

  // Proactive coach cards
  coach_title: { ur: "Aap ke liye", en: "For you" },
  coach_budget_over_t: { ur: "{category} budget se zyada", en: "{category} over budget" },
  coach_budget_over_b: { ur: "Cap se {amount} upar", en: "{amount} over the cap" },
  coach_overdue_t: { ur: "Aap ke paise rukay hain", en: "Money owed to you" },
  coach_overdue_b: { ur: "{count} log late hain — yaad dilayein", en: "{count} overdue — send a nudge" },
  coach_pace_t: { ur: "{category} tezi se khatam", en: "Pacing fast on {category}" },
  coach_pace_b: { ur: "{pct}% use, {days} din baqi", en: "{pct}% used, {days} days left" },
  coach_renew_t: { ur: "{count} renewals aane wale", en: "{count} renewals soon" },
  coach_renew_b: { ur: "Agle kuch dinon mein {amount}", en: "{amount} in the next few days" },
  coach_goal_t: { ur: "{title} peeche hai", en: "{title} is behind" },
  coach_goal_b: { ur: "Track par aane ko {amount} rakhein", en: "Set aside {amount} to catch up" },
  coach_top_t: { ur: "{category} jama ho raha", en: "{category} adds up" },
  coach_top_b: { ur: "Is mahine {count}× — {amount}", en: "{count}× this month — {amount}" },
  coach_log_t: { ur: "{days} din ho gaye", en: "It's been {days} days" },
  coach_log_b: { ur: "Ek chhoti entry add karein", en: "Log a quick entry to stay on top" },
  ai_understood: { ur: "Samajh gaya:", en: "Got it:" },
  // Daily money-wisdom popup
  quote_daily_title: { ur: "Aaj ki maali baat", en: "Daily money wisdom" },
  quote_got_it: { ur: "Theek hai", en: "Got it" },
  quote_share: { ur: "Share", en: "Share" },
  quote_turn_off: { ur: "Rozana baat band karein", en: "Turn off daily wisdom" },
  settings_daily_quote: { ur: "Rozana maali baat", en: "Daily money wisdom" },
  settings_daily_quote_desc: { ur: "Rozana ek chhoti, powerful maali baat", en: "A short money quote, once a day" },

  // ── Kameti / Committee ──
  kameti_title: { ur: "Kameti", en: "Kameti" },
  kameti_tile_desc: { ur: "Committee / BC track karein", en: "Track a committee / BC" },
  kameti_active_count: { ur: "{n} active", en: "{n} active" },
  kameti_empty_title: { ur: "Koi kameti nahi", en: "No committees yet" },
  kameti_empty_desc: { ur: "Apni committee, BC ya beesi yahan track karein — paisa aap ke darmiyan rehta hai, Hisaab sirf record rakhta hai.", en: "Track your committee, BC or beesi here — the money stays between you; Hisaab just keeps the record." },
  kameti_empty_cta: { ur: "Kameti banayein", en: "Create a committee" },
  kameti_new: { ur: "Nayi Kameti", en: "New committee" },
  kameti_create: { ur: "Banayein", en: "Create" },
  kameti_creating: { ur: "Ban rahi hai…", en: "Creating…" },
  kameti_name: { ur: "Kameti ka naam", en: "Committee name" },
  kameti_name_ph: { ur: "e.g. Office BC, Family Kameti", en: "e.g. Office BC, Family Kameti" },
  kameti_amount: { ur: "Har baari raqam (per member)", en: "Amount per member each round" },
  kameti_cadence: { ur: "Kitni baar?", en: "How often?" },
  kameti_cadence_daily: { ur: "Rozana", en: "Daily" },
  kameti_cadence_weekly: { ur: "Haftawar", en: "Weekly" },
  kameti_cadence_monthly: { ur: "Mahana", en: "Monthly" },
  kameti_start_date: { ur: "Shuru hone ki tareekh", en: "Start date" },
  kameti_method: { ur: "Baari ka tareeqa", en: "Payout order" },
  kameti_method_fixed: { ur: "Tay shuda tarteeb", en: "Fixed order" },
  kameti_method_fixed_desc: { ur: "Jis tarteeb mein members add hue", en: "The order members are added" },
  kameti_method_ballot: { ur: "Ballot / parchi", en: "Random ballot" },
  kameti_method_ballot_desc: { ur: "App parchi nikalega — sab dekh sakte hain", en: "App draws it — everyone can verify" },
  kameti_members: { ur: "Members", en: "Members" },
  kameti_add_member: { ur: "Member add karein", en: "Add member" },
  kameti_member_name_ph: { ur: "Naam", en: "Name" },
  kameti_member_phone_ph: { ur: "WhatsApp number (optional)", en: "WhatsApp number (optional)" },
  kameti_you_organizer: { ur: "Aap (organizer)", en: "You (organizer)" },
  kameti_min_members: { ur: "Kam az kam 2 members add karein", en: "Add at least 2 members" },
  kameti_need_one_member: { ur: "Kam az kam ek member add karein (aap khud organizer hain)", en: "Add at least one member (you're the organizer)" },
  kameti_pool: { ur: "Har baari ka pool", en: "Pool each round" },
  kameti_round_of: { ur: "Baari {r} / {n}", en: "Round {r} of {n}" },
  kameti_no_custody: { ur: "Hisaab paisa nahi rakhta", en: "Hisaab never holds the money" },
  kameti_no_custody_desc: { ur: "Paisa members ke darmiyan seedha jata hai. Hisaab sirf record aur reminder rakhta hai — isliye koi 'pool' churaane ko nahi.", en: "Money moves directly between members. Hisaab only keeps the record and reminders — so there's no pool to run off with." },
  kameti_sood_free: { ur: "Sood-free", en: "Interest-free" },
  kameti_schedule: { ur: "Baari ka schedule", en: "Payout schedule" },
  kameti_undrawn: { ur: "Baari abhi tay nahi hui", en: "Turn order not set yet" },
  kameti_run_ballot: { ur: "Parchi nikalein", en: "Draw the ballot" },
  kameti_drawing: { ur: "Parchi nikal rahi hai…", en: "Drawing…" },
  kameti_draw_fair_note: { ur: "App ek munsifana, verify-able tarteeb chun raha hai…", en: "Picking a fair, verifiable order — provably random…" },
  kameti_draw_confirm_title: { ur: "Parchi nikalein?", en: "Draw the ballot?" },
  kameti_draw_confirm_body: { ur: "Ek baar nikalne ke baad har member ki baari pakki ho jati hai — dobara nahi nikal sakte.", en: "Once drawn, the payout order is locked in for every member and can't be redrawn." },
  kameti_draw_confirm_cta: { ur: "Parchi nikalein", en: "Run ballot" },
  kameti_draw_done: { ur: "Baari tay ho gayi", en: "Turn order set" },
  kameti_slot_early: { ur: "Pehli baari — yeh advance jaisa hai", en: "Early turn — like an advance" },
  kameti_slot_late: { ur: "Aakhri baari — yeh bachat jaisa hai", en: "Late turn — like saving" },
  kameti_this_round: { ur: "Is baari", en: "This round" },
  kameti_tap_mark_paid: { ur: "Har member par tap kar ke unhe paid mark karein", en: "Tap a member to mark them paid this round" },
  kameti_collected: { ur: "{paid} / {total} ne diya", en: "{paid} of {total} paid" },
  kameti_arrears: { ur: "{amount} baqi · {n} baariyan", en: "{amount} behind · {n} rounds" },
  kameti_edit_member: { ur: "Member edit karein", en: "Edit member" },
  kameti_member_name: { ur: "Naam", en: "Name" },
  kameti_member_phone: { ur: "WhatsApp number", en: "WhatsApp number" },
  kameti_remind_unpaid: { ur: "Jinhone nahi diya unhe yaad dilayein", en: "Remind who hasn't paid" },
  kameti_baari_label: { ur: "Is baari ki raqam inhein", en: "This round's pool goes to" },
  kameti_received: { ur: "Mil gaya", en: "Received" },
  kameti_mark_received: { ur: "Mila — confirm karein", en: "Mark received" },
  kameti_owes_full: { ur: "Abhi {amount} dena baqi", en: "{amount} still owed" },
  kameti_paid_badge: { ur: "Diya", en: "Paid" },
  kameti_unpaid_badge: { ur: "Baqi", en: "Due" },
  kameti_remind: { ur: "Yaad dilayein", en: "Remind" },
  kameti_reminder_text: { ur: "Salam {name}, {committee} ki is baari ki qist {amount} due hai. Shukriya 🙂", en: "Salam {name}, your {amount} for {committee} this round is due. Thank you 🙂" },
  kameti_statement: { ur: "Committee ka record", en: "Committee statement" },
  kameti_share_statement: { ur: "Record share karein", en: "Share statement" },
  kameti_delete: { ur: "Kameti delete karein", en: "Delete committee" },
  kameti_delete_confirm: { ur: "Ye kameti aur uska saara record hat jayega. Wapas nahi hoga.", en: "This removes the committee and its whole record. This can't be undone." },
  kameti_deleted: { ur: "Kameti hata di", en: "Committee deleted" },
  // Phase 2 — verifiable draw + witness link
  kameti_verify_title: { ur: "Saaf parchi — koi bhi check kar sakta hai", en: "Fair draw — anyone can check it" },
  kameti_verify_desc: { ur: "Jab parchi nikli, app ne uska ek band lifafa save kiya. Yeh button dobara check karta hai ke tarteeb bilkul wohi hai — kisi ne badli to nahi.", en: "When the draw was made, the app sealed a copy of it. This checks the order again to prove no one changed it." },
  kameti_commitment: { ur: "Parchi ka band lifafa", en: "The sealed draw record" },
  kameti_verify: { ur: "Parchi dobara check karein", en: "Check this draw" },
  kameti_verifying: { ur: "Check ho raha…", en: "Checking…" },
  kameti_verify_ok: { ur: "Sahi ✓ — tarteeb bilkul wohi hai jo seal hui thi, kuch nahi badla", en: "Checked ✓ — the order is exactly as sealed, nothing was changed" },
  kameti_verify_fail: { ur: "Match nahi — tarteeb badli gayi hai", en: "Doesn't match — the order was changed" },
  // Server-side draw (audit 2026-09 C10/M10) — the ballot is drawn once, on the
  // server, and can never be re-rolled.
  kameti_draw_already: { ur: "Is kameti ki parchi pehle hi nikal chuki hai — dobara nahi nikalti", en: "This kameti's ballot was already drawn — it can't be drawn again" },
  kameti_draw_locked: { ur: "Baari tay ho chuki — ab koi ise badal nahi sakta, organiser bhi nahi", en: "Turn order is locked — nobody can change it now, not even the organiser" },
  kameti_draw_failed: { ur: "Parchi nahi nikal saki. Dobara koshish karein.", en: "Couldn't run the draw. Please try again." },
  kameti_draw_too_few: { ur: "Parchi ke liye kam se kam 2 members chahiye", en: "You need at least 2 members to draw" },
  kameti_draw_not_organizer: { ur: "Sirf organiser parchi nikal sakta hai", en: "Only the organiser can run the draw" },
  kameti_draw_server_note: { ur: "Parchi Hisaab ke server ne nikali — number kisi ke phone se nahi aaya, isliye koi ise dobara nahi chala sakta.", en: "The draw was made on Hisaab's server — the random number never came from anyone's phone, so nobody can re-roll it." },
  kameti_draw_seed: { ur: "Parchi ka number (seed)", en: "Draw number (seed)" },
  kameti_draw_recompute_how: { ur: "Khud check karna hai? Har member ka SHA-256 nikalein: seed:member-id — phir in hashes ko chhote se bade tarteeb dein. Wohi baari ki tarteeb hai.", en: "Want to check it yourself? Take SHA-256 of seed:member-id for each member, then sort those hashes smallest to largest. That is the payout order." },
  kameti_share_witness: { ur: "Witness link share karein", en: "Share witness link" },
  kameti_witness_title: { ur: "Committee record", en: "Committee record" },
  kameti_witness_banner: { ur: "Ye shared committee record hai. Hisaab paisa nahi rakhta — ye woh sachcha record hai jo sab members dekhte hain.", en: "A shared committee record. Hisaab never holds the money — this is the honest ledger every member sees." },
  kameti_witness_invalid: { ur: "Ye committee link ghalat hai ya hata diya gaya.", en: "This committee link is invalid or was removed." },
  kameti_witness_msg: { ur: "{committee} ka committee record dekhein: {url}", en: "See the {committee} committee record: {url}" },
  kameti_get_app: { ur: "Hisaab istemal karein", en: "Open in Hisaab" },
  budget_over_by_short: { ur: "{amount} over", en: "{amount} over" },
  budget_over_by: { ur: "{amount} se zyada ho gaya", en: "over by {amount}" },
  // Loan / QuickEntry helpers
  loan_they: { ur: "Woh", en: "They" },
  loan_will_confirm: { ur: "{name} ko confirm karne ki request jayegi", en: "{name} will get a request to confirm this" },
  loan_private: { ur: "Private — sirf aap dekh sakte ho", en: "Private — only you see this" },
  qe_after: { ur: "Baad mein: {amount}", en: "After: {amount}" },
  qe_low_balance: { ur: "· Balance kam", en: "· Low balance" },
  // Analytics
  analytics_showing: { ur: "Dikha rahe", en: "Showing" },
  analytics_net: { ur: "Net", en: "Net" },
  analytics_spend_trend: { ur: "Kharcha", en: "Spending" },
  analytics_vs_prev: { ur: "pichle se", en: "vs previous" },
  analytics_no_change: { ur: "lagbhag barabar", en: "about the same" },
  analytics_empty_desc: { ur: "Thoda kharcha aur amdani likho, phir aapke spend trends, categories aur net flow yahan dikhne lagenge.", en: "Log a few expenses and income, and your spend trends, categories and net flow show up here." },
  analytics_empty_cta: { ur: "Transaction add karo", en: "Add a transaction" },
  // Group expense split
  split_allocated: { ur: "Allocated {a} / {b}", en: "Allocated {a} / {b}" },
  split_total_pct: { ur: "Total {n}%", en: "Total {n}%" },
  split_total_shares: { ur: "Total {n} shares", en: "Total {n} shares" },
  // Ad-hoc split (no group) — QuickEntry chip + SplitWithSheet
  split_chip_label: { ur: "Kisi ke sath bantna hai?", en: "Split this?" },
  split_chip_none: { ur: "Sirf mera", en: "Just me" },
  split_chip_active: { ur: "{n} logon mein banta", en: "Split {n} ways" },
  split_with_title: { ur: "Kis kis ke sath bantna hai", en: "Split with" },
  split_apply: { ur: "Split lagao", en: "Apply split" },
  split_remove: { ur: "Split hata do", en: "Remove split" },
  split_remove_person: { ur: "{name} ko hatao", en: "Remove {name}" },
  split_who_paid: { ur: "Paisay kis ne diye?", en: "Who paid?" },
  split_i_paid: { ur: "Main ne diye", en: "I paid" },
  split_they_paid: { ur: "Kisi aur ne diye", en: "Someone else paid" },
  split_between: { ur: "Kin ke darmiyan", en: "Split between" },
  split_you: { ur: "Aap", en: "You" },
  split_add_placeholder: { ur: "Naam likho ya contact chuno", en: "Type a name or pick a contact" },
  split_add_named: { ur: "\"{name}\" ko shamil karo", en: "Add \"{name}\"" },
  split_already_added: { ur: "{name} pehle se shamil hai", en: "{name} is already in this split" },
  split_payer_label: { ur: "Kis ne pay kia?", en: "Who paid the bill?" },
  split_need_payer: { ur: "Chuno kis ne pay kia", en: "Pick who paid" },
  split_summary_i_paid: { ur: "Account se poore {total} jayenge. Aapka hissa {mine}, baqi {owed} log aap ko dene hain.", en: "The full {total} leaves your account. {mine} is your share; {owed} comes back to you." },
  split_summary_they_paid: { ur: "{name} ko aap ke {mine} dene hain. Aap ke account se abhi kuch nahi jayega.", en: "You'll owe {name} {mine}. Nothing leaves your account now." },
  split_no_group_hint: { ur: "Group banane ki zaroorat nahi — yeh seedha har bande ke hisaab mein chala jayega.", en: "No group needed — this settles straight against each person's balance." },
  split_ways: { ur: "{n} logon mein banta", en: "split {n} ways" },
  split_saved_title: { ur: "Split mehfooz ho gaya", en: "Split saved" },
  split_saved_i_paid: { ur: "{total} nikla. {n} logon ne aap ko {owed} dena hai.", en: "{total} paid. {n} people owe you {owed}." },
  split_saved_they_paid: { ur: "Aap ne {name} ko {mine} dene hain.", en: "You owe {name} {mine}." },
  split_partial_title: { ur: "{total} mein se {done} mehfooz hue", en: "Saved {done} of {total}" },
  split_locked_edit: { ur: "Yeh ek split ka hissa hai — poora split hi edit ya delete karo.", en: "This is part of a split — edit or delete the whole split instead." },
  split_delete_event: { ur: "Poora split delete karo", en: "Delete the whole split" },
  split_delete_confirm: { ur: "\"{label}\" ki saari {n} entries delete ho jayengi — aap ka hissa aur har bande ka lena dena. Yeh wapas nahi aa sakta.", en: "This removes all {n} entries from \"{label}\" — your own share and every person's balance. This can't be undone." },
  split_delete_blocked: { ur: "Is split mein se kisi ne kuch wapas kar diya hai. Pehle woh repayment hatao, phir split delete karo.", en: "Someone has already paid part of this split back. Remove that repayment first, then delete the split." },
  // Home
  home_owed: { ur: "dena", en: "owed" },
  home_net_liab: { ur: "Liabilities ke baad", en: "Net of liabilities" },
  home_record_iou_hint: { ur: "Kis ne kis ka dena hai, likho aur shuru karo.", en: "Record who owes whom to get started." },
  home_record_iou_cta: { ur: "IOU likho", en: "Record an IOU" },
  home_people_to_settle: { ur: "{n} log settle karne hain", en: "{n} to settle" },
  home_groups_active: { ur: "{n} group active", en: "{n} groups active" },
  home_more_reminders: { ur: "{n} aur reminders", en: "{n} more reminders" },
  home_more_reminder_one: { ur: "1 aur reminder", en: "1 more reminder" },
  // Contact detail (linked account)
  contact_linked_to: { ur: "Linked", en: "Linked to" },
  contact_not_linked: { ur: "Kisi Hisaab user se linked nahin", en: "Not linked to a Hisaab user" },
  contact_linked_pill: { ur: "Linked", en: "Linked" },
  // Group members / legend
  member_on_app: { ur: "Hisaab par", en: "on Hisaab" },
  member_invited: { ur: "invite bheji", en: "invite sent" },
  member_not_on_app: { ur: "app par nahin", en: "not on app" },
  member_owner: { ur: "owner", en: "owner" },
  // Hisaab AI
  ai_view_txns: { ur: "Ye {count} transactions dekho", en: "View these {count} transactions" },
  ai_view_txn_one: { ur: "Ye transaction dekho", en: "View this transaction" },
  // Goals
  goal_to_go: { ur: "{amount} baqi", en: "{amount} to go" },
  goal_pace: { ur: "is raftaar se takreeban {n} mahine", en: "about {n} mo at this pace" },
  // Loans
  status_linked: { ur: "Linked", en: "Linked" },
  loans_pending_banner: { ur: "Aapke inbox mein {count} pending request", en: "{count} pending request in your inbox" },
  loans_pending_banner_plural: { ur: "Aapke inbox mein {count} pending requests", en: "{count} pending requests in your inbox" },
  loans_pending_reply: { ur: "{count} aapke jawab ke muntazir", en: "{count} need your reply" },
  // PIN lock
  pin_try_again: { ur: "{s}s baad dobara koshish karo", en: "Try again in {s}s" },
  pin_tries_left: { ur: "{n} koshishein baqi", en: "{n} tries left" },
  pin_tries_left_one: { ur: "1 koshish baqi", en: "1 try left" },
  pin_forgot: { ur: "PIN bhool gaye?", en: "Forgot PIN?" },
  pin_recovery: { ur: "PIN reset nahin hota — yeh sirf is device ko lock karta hai. Sign out karke dobara sign in karo, phir Settings mein naya PIN set karo.", en: "There's no PIN reset — your PIN locks this device only. Sign out and sign back in to clear it, then set a new PIN in Settings." },
  pin_signout_reset: { ur: "Reset ke liye sign out karo", en: "Sign out to reset" },
  pin_signing_out: { ur: "Sign out ho raha hai…", en: "Signing out…" },
  // Join group
  join_find_cta: { ur: "Group dhoondo", en: "Find group" },
  join_confirm_cta: { ur: "Is group mein join karo", en: "Join this group" },
  join_ready: { ur: "Join karne ke liye taiyar", en: "Ready to join" },
  join_double_check: { ur: "Ek dafa check karo ke code sahi hai, phir neeche “Join this group” dabao. Join hote hi aap group ke kharchay aur members dekh paoge.", en: "Double-check this is the right code, then tap “Join this group” below. You'll see the group's expenses and members once you're in." },
  join_use_different: { ur: "Doosra code istemal karo", en: "Use a different code" },
  // Audit UX-18: the confirm step now shows the actual group, not an echo of
  // the code the user just typed. Copy for the preview card.
  join_finding: { ur: "Group dhoonda ja raha hai…", en: "Looking up group…" },
  join_preview_label: { ur: "Aap yeh group join kar rahe hain", en: "You're about to join" },
  join_preview_owner: { ur: "{name} ne yeh group banaya hai", en: "Created by {name}" },
  join_preview_members: { ur: "{n} log pehle se shamil hain", en: "{n} people already in" },
  join_preview_members_one: { ur: "1 shaks pehle se shamil hai", en: "1 person already in" },
  join_preview_double_check: { ur: "Sahi group hai? Join karte hi aap ka naam sab members ko nazar aayega, aur nikalne se pehle hisaab barabar karna hoga.", en: "Right group? Once you join, your name is visible to every member, and you'll need to settle up before you can leave." },
  join_preview_archived_label: { ur: "Yeh group band ho chuka hai", en: "This group is closed" },
  join_preview_archived_body: { ur: "Owner ne ise archive kar diya hai — is mein naye members shamil nahi ho sakte.", en: "The owner archived it — no new members can join." },
  join_preview_archived_help: { ur: "Agar aap ko lagta hai yeh ghalti hai to group ke owner se kehein ke ise dobara khol dein.", en: "If you think that's a mistake, ask the group's owner to reopen it." },
  join_preview_unavailable: { ur: "Is code ki tafseel abhi nahi dikhayi ja sakti — join karne ke baad group ka naam aur members nazar aayenge.", en: "Details for this code aren't available right now — you'll see the group's name and members after joining." },
  join_error_archived: { ur: "Yeh group band ho chuka hai. Naye members shamil nahi ho sakte.", en: "This group is closed. New members can't join." },
  // Loan detail — cancel settlement
  loan_cancel_settle_title: { ur: "Yeh settlement request cancel karein?", en: "Cancel this settlement request?" },
  loan_cancel_settle_body: { ur: "Pending {amount} settlement dono taraf apply nahin hogi.", en: "The pending {amount} settlement won't be applied on either side." },
  loan_cancel_request: { ur: "Request cancel karo", en: "Cancel request" },
  // Transactions
  tx_search_placeholder: { ur: "Notes, category, banda, amount dhoondo", en: "Search notes, category, person, amount" },
  // Onboarding
  onboard_recommended: { ur: "Tajweez karda", en: "Recommended" },
  // ── Onboarding mode quiz ──
  quiz_title: { ur: "Chalein aap ka mode dhoondte hain", en: "Let's find your fit" },
  quiz_sub: { ur: "3 quick taps — hum ek mode tajweez karenge (aap phir bhi koi bhi chun sakte hain)", en: "3 quick taps — we'll suggest a mode (you can still pick either)" },
  quiz_progress: { ur: "Sawal {n} / {total}", en: "Question {n} of {total}" },
  quiz_q1: { ur: "Hisaab aap ke liye kis liye hai?", en: "What's Hisaab for you?" },
  quiz_q1_a: { ur: "Apna saara paisa track karna — kharche, budget, accounts", en: "Track all my money — spending, budgets, accounts" },
  quiz_q1_b: { ur: "Sirf len-den — doston ke saath bill split", en: "Just who-owes-who — splitting bills with friends" },
  quiz_q1_c: { ur: "Sach kahun to, thoda dono", en: "Honestly, a bit of both" },
  quiz_q2: { ur: "Kya aap ke paas cash ya bank accounts hain jo aap dekhna chahein?", en: "Do you keep cash or bank accounts you'd like to see?" },
  quiz_q2_a: { ur: "Haan — mujhe mere balances dikhao", en: "Yes — show me my balances" },
  quiz_q2_b: { ur: "Nahi — main bas logon se hisaab barabar karta hun", en: "Nope — I just settle up with people" },
  quiz_q3: { ur: "Budget aur spending insights chahiye?", en: "Want budgets & spending insights?" },
  quiz_q3_a: { ur: "Haan, mujhe track par rakho", en: "Yes, help me stay on track" },
  quiz_q3_b: { ur: "Nahi, simple rakho — sirf IOUs aur splits", en: "No, keep it simple — just IOUs & splits" },
  quiz_skip: { ur: "Skip — main khud chun lunga", en: "Skip — I'll choose myself" },
  quiz_reco: { ur: "Aap ke jawabat ke mutabiq, hum tajweez karte hain:", en: "Based on your answers, we suggest:" },
  quiz_retake: { ur: "Quiz dobara karein", en: "Retake quiz" },
  quiz_for_you: { ur: "Aap ke liye", en: "For you" },
  // ── Onboarding first-account step (full_tracker only) ──
  onboard_acct_title: { ur: "apna pehla account banayein", en: "add your first account" },
  onboard_acct_sub: { ur: "Taake aap ke balances pehle din se tayyar hon.", en: "So your balances are ready from day one." },
  onboard_acct_type: { ur: "Account ki qisam", en: "Account type" },
  acct_type_cash: { ur: "Cash", en: "Cash" },
  acct_type_bank: { ur: "Bank", en: "Bank" },
  acct_type_wallet: { ur: "Wallet", en: "Wallet" },
  // Account grouping sections — used everywhere accounts are listed/picked.
  acct_group_wallets_cash: { ur: "Wallets aur Cash", en: "Wallets & Cash" },
  acct_group_banks: { ur: "Bank Accounts", en: "Banks" },
  acct_group_cards: { ur: "Credit Cards", en: "Credit Cards" },
  // Collapsed account selector — one selected row, tap to expand the list.
  acct_select_placeholder: { ur: "Account chunein", en: "Choose an account" },
  acct_select_change: { ur: "Badlein", en: "Change" },

  // ── Investment tracker ──
  inv_title: { ur: "Investment Tracker", en: "Investment Tracker" },
  inv_record_only: { ur: "Aap ka apna record — investment advice nahi", en: "Your own record — not investment advice" },
  inv_invested: { ur: "Lagaya hua", en: "Invested" },
  inv_current_value: { ur: "Mojooda value", en: "Current value" },
  inv_unrealized: { ur: "Unrealized nafa-nuqsan", en: "Unrealized profit & loss" },
  inv_realized: { ur: "Realized nafa-nuqsan", en: "Realized profit & loss" },
  inv_dividends: { ur: "Dividends", en: "Dividends" },
  inv_fees_total: { ur: "Fees diye", en: "Fees paid" },
  inv_all_markets: { ur: "Sab", en: "All" },
  inv_manage_markets: { ur: "Markets manage karein", en: "Manage markets" },
  inv_new_market: { ur: "Naya market", en: "New market" },
  inv_market_name: { ur: "Market ka naam", en: "Market name" },
  inv_market_name_ph: { ur: "e.g. DFM, PSX", en: "e.g. DFM, PSX" },
  inv_market_currency: { ur: "Currency", en: "Currency" },
  inv_market_suggest: { ur: "Mashhoor — tap karke bharein", en: "Popular — tap to fill" },
  inv_market_delete_blocked: { ur: "Is market mein trades hain — pehle woh delete karein.", en: "This market has trades. Delete them first." },
  inv_market_currency_locked: { ur: "Pehli trade ke baad currency lock ho jati hai", en: "Currency locks after the first trade" },
  inv_market_has_holdings: { ur: "{n} holdings", en: "{n} holdings" },
  inv_record_trade: { ur: "Trade likhein", en: "Record trade" },
  inv_buy: { ur: "Khareeda", en: "Buy" },
  inv_sell: { ur: "Becha", en: "Sell" },
  inv_dividend: { ur: "Dividend", en: "Dividend" },
  inv_symbol: { ur: "Symbol / stock", en: "Symbol / stock" },
  inv_symbol_ph: { ur: "e.g. EMAAR", en: "e.g. EMAAR" },
  inv_new_symbol_hint: { ur: "Naya — {market} mein add hoga", en: "New — will be added to {market}" },
  inv_qty: { ur: "Kitne shares", en: "Quantity" },
  inv_price_per_unit: { ur: "Price per share", en: "Price per share" },
  inv_fees: { ur: "Fees / charges", en: "Fees / charges" },
  inv_fees_dividend: { ur: "Tax / fees", en: "Tax / fees" },
  inv_total_cost: { ur: "Total kharcha", en: "Total cost" },
  inv_total_proceeds: { ur: "Aap ko milenge", en: "You receive" },
  inv_dividend_amount: { ur: "Dividend amount (gross)", en: "Dividend amount (gross)" },
  inv_trade_date: { ur: "Tareekh", en: "Date" },
  inv_paid_from: { ur: "Kis account se", en: "Paid from" },
  inv_received_into: { ur: "Kis account mein aaye", en: "Received into" },
  inv_outside_toggle: { ur: "Hisaab se bahar — kisi account ko na chhuein", en: "Held outside Hisaab — don't touch an account" },
  inv_outside_chip: { ur: "Hisaab se bahar", en: "outside Hisaab" },
  inv_you_hold: { ur: "Aap ke paas {qty} @ avg {price}", en: "You hold {qty} @ avg {price}" },
  inv_sell_too_many: { ur: "Aap ke paas sirf {qty} hain", en: "You only hold {qty}" },
  inv_realized_preview: { ur: "Is sale par nafa-nuqsan", en: "Profit & loss on this sale" },
  inv_trade_saved_buy: { ur: "Buy likh liya", en: "Buy recorded" },
  inv_trade_saved_sell: { ur: "Sell likh liya", en: "Sell recorded" },
  inv_trade_saved_div: { ur: "Dividend likh liya", en: "Dividend recorded" },
  inv_update_price: { ur: "Price update karein", en: "Update price" },
  inv_update_prices: { ur: "Prices update karein", en: "Update prices" },
  inv_price_label: { ur: "Aaj ki price", en: "Today's price" },
  inv_price_asof_days: { ur: "price {days} din purani", en: "price from {days} days ago" },
  inv_price_never: { ur: "price abhi nahi di — set karein", en: "no price yet — set one" },
  inv_unpriced_chip: { ur: "{n} bina price ke", en: "{n} without price" },
  inv_empty_title: { ur: "Apni investments track karein", en: "Track your investments" },
  inv_empty_desc: { ur: "DFM, PSX ya koi bhi market — buys, sells aur dividends aik jagah", en: "DFM, PSX or any market — buys, sells and dividends in one place" },
  inv_empty_cta: { ur: "Market set karein", en: "Set up a market" },
  inv_first_trade_cta: { ur: "Pehli trade likhein", en: "Record first trade" },
  inv_closed_positions: { ur: "Band positions", en: "Closed positions" },
  inv_position_closed: { ur: "Position band", en: "Position closed" },
  inv_buy_more: { ur: "Aur khareedein", en: "Buy more" },
  inv_history: { ur: "Trade history", en: "Trade history" },
  inv_delete_trade: { ur: "Trade delete karein", en: "Delete trade" },
  inv_delete_trade_confirm_title: { ur: "Yeh trade delete karein?", en: "Delete this trade?" },
  inv_delete_trade_confirm_body: { ur: "Agar account juda tha to balance wapas theek ho jayega.", en: "If an account was involved, its balance will be reversed exactly." },
  inv_holding_not_found: { ur: "Holding nahi mili", en: "Holding not found" },
  inv_avg_cost_note: { ur: "avg cost = total buy kharcha ÷ shares (fees included)", en: "avg cost = total buy cost ÷ shares (fees included)" },
  inv_rename_market: { ur: "Naam badlein", en: "Rename" },
  inv_delete_market: { ur: "Market delete karein", en: "Delete market" },
  inv_delete_market_confirm: { ur: "{name} delete karein?", en: "Delete {name}?" },
  // Celebration / encouragement moments — small interactions that keep
  // tracking a habit instead of a chore.
  inv_cheer_first_trade: { ur: "Mubarak ho! 🎉 Pehli investment likh li", en: "Mubarak! 🎉 Your first investment is on the books" },
  inv_cheer_first_trade_guide: { ur: "Price update karte rahein taake nafa-nuqsan hamesha taaza rahe.", en: "Keep the price updated and your profit & loss stays fresh." },
  inv_cheer_buy: { ur: "Buy likh liya — portfolio barh raha hai! 📈", en: "Buy recorded — portfolio growing! 📈" },
  inv_cheer_sell_profit: { ur: "Zabardast trade! {amount} ka nafa lock ho gaya 🎉", en: "Great trade! You locked in {amount} profit 🎉" },
  inv_cheer_sell_loss: { ur: "Sach-sach track karna hi asli hunar hai — nuqsan har investor ke hote hain. 💪", en: "Honest tracking beats guessing — every investor takes some losses. 💪" },
  inv_cheer_dividend: { ur: "Dividend mila — paisa aap ke liye kaam kar raha hai! 💰", en: "Dividend received — your money is working for you! 💰" },
  inv_cheer_first_market: { ur: "Market tayyar! 🎉", en: "Market ready! 🎉" },
  inv_cheer_first_market_guide: { ur: "Ab apni pehli trade likhein — buy, sell ya dividend.", en: "Now record your first trade — a buy, sell or dividend." },
  action_invested: { ur: "Shares khareede", en: "Bought shares" },
  action_sold_investment: { ur: "Shares beche", en: "Sold shares" },
  action_dividend: { ur: "Dividend mila", en: "Dividend received" },
  onboard_acct_name: { ur: "Account ka naam", en: "Account name" },
  onboard_acct_name_ph: { ur: "e.g. Cash, Meezan, JazzCash", en: "e.g. Cash, Meezan, JazzCash" },
  onboard_acct_balance: { ur: "Mojooda balance (optional)", en: "Opening balance (optional)" },
  onboard_acct_create: { ur: "Account banayein aur shuru karein", en: "Create account & start" },
  onboard_acct_skip: { ur: "Abhi rehne dein", en: "Skip for now" },
  onboard_switch_anytime: { ur: "Settings mein kabhi bhi badal sakte ho.", en: "You can switch anytime in Settings." },
  // Inbox
  confirm_settle_cta: { ur: "Settlement confirm karo", en: "Confirm settlement" },
  inbox_incoming_explainer: { ur: "Aapke linked contacts ki requests yahan aayengi — accept ya decline karne ke liye.", en: "Requests from your linked contacts will land here for you to accept or decline." },
  inbox_send_request: { ur: "Linked request bhejo", en: "Send a linked request" },
  inbox_resolved_divider: { ur: "Pehle ke", en: "Earlier" },
  // "Remind them" on outgoing pending requests — one-tap WhatsApp nudge when
  // the other party hasn't confirmed. {name}/{amount} are substituted.
  req_remind_cta: { ur: "Yaad dilao", en: "Remind" },
  req_remind_linked_lent: {
    ur: "Salam {name}! Maine Hisaab par {amount} ki request bheji hai (jo maine aapko diye thay). Jab time mile, app khol kar confirm kar dena 🙂",
    en: "Salam {name}! I sent you a request on Hisaab for the {amount} I lent you — please open the app and confirm when you get a minute 🙂",
  },
  req_remind_linked_borrowed: {
    ur: "Salam {name}! Maine Hisaab par {amount} record kiya hai jo maine aap se udhaar liya tha. Jab time mile, app khol kar confirm kar dena 🙂",
    en: "Salam {name}! I logged the {amount} I borrowed from you on Hisaab — please open the app and confirm when you get a minute 🙂",
  },
  req_remind_settlement: {
    ur: "Salam {name}! Maine Hisaab par {amount} settle mark kiya hai — app khol kar accept kar dena taake dono ka hisaab barabar rahe 🙂",
    en: "Salam {name}! I marked {amount} as settled on Hisaab — please open the app and accept so both our books match 🙂",
  },
  inbox_card_incoming_lent_full: { ur: "aapko {name} ko dena hoga", en: "you'd owe {name}" },
  inbox_card_incoming_borrowed_full: { ur: "{name} ko aapko dena hoga", en: "{name} would owe you" },
  // Settings group headers
  settings_grp_account: { ur: "Account aur security", en: "Account & security" },
  settings_grp_money: { ur: "Aapka paisa", en: "Your money" },
  settings_grp_data: { ur: "Data aur backup", en: "Data & backup" },
  settings_grp_about: { ur: "About aur legal", en: "About & legal" },
  // Subscriptions
  subs_paused: { ur: "Saari subscriptions paused", en: "All subscriptions paused" },
  subs_active_count: { ur: "{c} active", en: "{c} active" },
  subs_duplicate: { ur: "Double charge ho sakta hai — review karo", en: "Possible double charge — review" },
  subs_per_mo: { ur: "~ {amount}/mahina", en: "~ {amount}/mo" },
  // Settle up modal
  settle_you_pay: { ur: "Aap {name} ko do", en: "You pay {name}" },
  settle_pays_you: { ur: "{name} aapko de", en: "{name} pays you" },
  settle_pays: { ur: "{from} {to} ko de", en: "{from} pays {to}" },
  settle_remaining: { ur: "Iske baad baqi: {amount}", en: "Remaining after this: {amount}" },
  settle_fully_settled: { ur: "Pura settle ho gaya", en: "Fully settled" },
  settle_full: { ur: "Poora {amount}", en: "Full {amount}" },
  settle_partial: { ur: "Thoda sa", en: "Partial" },
  settle_done: { ur: "Done", en: "Done" },
  settle_all_square: { ur: "Sab barabar", en: "Everyone's square" },
  settle_all_square_sub: { ur: "Is group mein abhi koi baqaya balance settle karne ko nahin.", en: "There are no outstanding balances to settle in this group right now." },
  // Repayment modal
  repay_full: { ur: "Poora", en: "Full" },
  repay_half: { ur: "Aadha", en: "Half" },
  repay_next: { ur: "Agli qist", en: "Next instalment" },
  repay_done_received_from: { ur: "{amount} {person} se wusool hue", en: "{amount} received from {person}" },
  repay_done_paid_to: { ur: "{amount} {person} ko ada kiye", en: "{amount} repaid to {person}" },
  repay_full_amount: { ur: "Poora amount: {amount}", en: "Full amount: {amount}" },
  emi_note_paid: { ur: "EMI #{n} ada", en: "EMI #{n} paid" },
  // Consolidated repayment (AllocateRepaymentModal)
  alloc_confirm_received: { ur: "{person} {amount} wapas kar rahe hain — {n} qarz par.", en: "{person} is paying back {amount} across {n} loan(s)." },
  alloc_confirm_paid: { ur: "Aap {person} ko {amount} de rahe hain — {n} qarz par.", en: "You're paying {person} {amount} across {n} loan(s)." },
  alloc_no_account: { ur: "Is ke liye koi {currency} account nahi hai.", en: "No {currency} account to record this against." },
  // Quick Entry result confirmations
  qe_done_deducted: { ur: "{amount} {account} se minus ho gaye.", en: "{amount} was deducted from {account}." },
  qe_done_added: { ur: "{amount} {account} mein aa gaye.", en: "{amount} was added to {account}." },
  qe_done_moved: { ur: "{amount} {src} se {dst} mein move ho gaye.", en: "{amount} moved from {src} to {dst}." },
  title_saved_emi_pending: { ur: "{label} — Save ho gaya (EMI baqi)", en: "{label} — Saved (EMI pending)" },
  title_done: { ur: "{label} — Ho gaya!", en: "{label} — Done!" },
  repay_done_received_desc: { ur: "{person} ne {amount} wapas kar diye.", en: "{person} paid you back {amount}." },
  repay_done_paid_desc: { ur: "Aap ne {person} ko {amount} wapas kar diye.", en: "You paid {person} back {amount}." },
  loan_done_owes_you: { ur: "{person} ne aap ko {amount} dena hai.", en: "{person} owes you {amount}." },
  loan_done_you_owe: { ur: "Aap ne {person} ko {amount} dena hai.", en: "You owe {person} {amount}." },
  qe_which_group: { ur: "Kaun sa group?", en: "Which group?" },
  emi_schedule_failed_title: { ur: "EMI schedule nahi bana", en: "EMI schedule not created" },
  emi_schedule_failed_sub: { ur: "Transaction save ho gayi, lekin qiston ka plan nahi ban saka. Loan khol kar dobara koshish karein.", en: "Your transaction was saved, but setting up the installment plan failed. Open the loan to retry." },
  // Loan detail page — hero, EMI schedule & reconcile
  loan_hero_owes_you: { ur: "{name} ne dena hai", en: "{name} owes you" },
  loan_hero_you_owe: { ur: "Aap ne {name} ko dena hai", en: "You owe {name}" },
  loan_since_date: { ur: "{date} se", en: "since {date}" },
  loan_of_total: { ur: "kul {amount} mein se", en: "of {amount}" },
  emi_schedule_heading: { ur: "Qiston ka schedule", en: "Schedule" },
  emi_instalment_n: { ur: "Qist {n}", en: "Instalment {n}" },
  emi_row_paid: { ur: "ada", en: "paid" },
  emi_row_overdue: { ur: "late", en: "overdue" },
  emi_next_label: { ur: "Agli qist", en: "Next instalment" },
  emi_due_in_days: { ur: "{n} din mein", en: "in {n} days" },
  emi_cleared_line: { ur: "{paid} / {total} qistein clear", en: "{paid} of {total} instalments cleared" },
  emi_reconcile_title: { ur: "Pehle se ada?", en: "Already paid?" },
  emi_reconcile_body: { ur: "Aap is qarz par {amount} wapas kar chuke hain, lekin {n} qist(ein) abhi bhi unpaid dikh rahi hain. Dobara diye baghair paid mark karein.", en: "You've repaid {amount} on this loan, but {n} instalment(s) still show unpaid. Mark them paid without paying again." },
  emi_reconcile_marking: { ur: "Mark ho rahi…", en: "Marking…" },
  emi_reconcile_cta: { ur: "{n} paid mark karo", en: "Mark {n} as paid" },
  emi_marked_paid_one: { ur: "Qist paid mark ho gayi", en: "Instalment marked paid" },
  emi_marked_paid_many: { ur: "{n} qistein paid mark ho gayin", en: "{n} instalments marked paid" },
  emi_marked_paid_sub: { ur: "Jo paisay aap pehle wapas kar chuke unse milaya — kuch charge nahi hua.", en: "Matched to money you already repaid — nothing was charged." },
  loading: { ur: "Load ho raha hai…", en: "Loading…" },
  // Account detail page — labels & money-math card
  label_balance: { ur: "Balance", en: "Balance" },
  label_total: { ur: "Total", en: "Total" },
  rename: { ur: "Naam badlein", en: "Rename" },
  mm_title: { ur: "Aap ke paise par is ka asar", en: "How this affects Your Money" },
  mm_added: { ur: "Aap ke paison mein juda", en: "Added to Your Money" },
  mm_subtracted: { ur: "Aap ke paison se minus", en: "Subtracted from Your Money" },
  mm_available_balance: { ur: "Available (balance)", en: "Available (balance)" },
  mm_overpaid_above: { ur: "Zyada ada (limit se upar)", en: "Overpaid (above limit)" },
  mm_you_owe_used: { ur: "Dena hai (used)", en: "You owe (used)" },
  mm_no_limit_warn: { ur: "Credit limit set nahi — Hisaab nahi bata sakta card kitna use hua hai. Card details mein limit set karein taake aap ka net worth sahi dikhe.", en: "No credit limit set — Hisaab can't tell how much of this card you've used. Open the card details to set the limit so your net worth reflects what you actually owe." },
  // Recurring due prompt
  rec_due_title: { ur: "Recurring entry due hai", en: "Recurring entry due" },
  rec_posting: { ur: "Post ho rahi…", en: "Posting…" },
  rec_confirm_post: { ur: "Confirm kar ke post karo", en: "Confirm & post" },
  rec_skip_one: { ur: "Is dafa skip karo", en: "Skip this one" },
  rec_pause: { ur: "Pause", en: "Pause" },
  rec_due_on: { ur: "{date} ko due", en: "Due {date}" },
  rec_to_account: { ur: "{account} mein", en: "to {account}" },
  rec_from_account: { ur: "{account} se", en: "from {account}" },
  rec_posted_title: { ur: "{name} post ho gayi", en: "{name} posted" },
  rec_post_failed_title: { ur: "Post nahi ho saki", en: "Could not post" },
  rec_more_after: { ur: "Is ke baad {n} aur", en: "{n} more after this one" },
  rec_paused_toast: { ur: "Pause ho gayi. Recurring se kabhi bhi dobara chalu karein.", en: "Paused. Resume anytime from Recurring." },
  // Edit transaction modal
  tx_details_title: { ur: "Entry ki tafseel", en: "Entry details" },
  tx_delete_entry: { ur: "Entry delete karo", en: "Delete entry" },
  tx_updated: { ur: "Entry update ho gayi", en: "Entry updated" },
  label_from: { ur: "Kis account se:", en: "From:" },
  label_to: { ur: "Kis account mein:", en: "To:" },
  label_person: { ur: "Shakhs:", en: "Person:" },
  tx_group_expense_warn: { ur: "Yeh entry group kharche ki hai. Group details screen se edit ya delete karein.", en: "This entry belongs to a group expense. Edit or delete it from the group details screen." },
  // Add loan modal
  amount_label: { ur: "Raqam", en: "Amount" },
  cash_advance_none: { ur: "Koi credit card nahi", en: "No credit card" },

  // ── Flex budget ("Bacha kya hai?") ──
  flex_title: { ur: "Bacha kya hai?", en: "What's left?" },
  flex_setup_desc: {
    ur: "Mahana income batao — EMI, kameti aur recurring nikaal kar hum dikhayenge ke asal mein kitna free hai.",
    en: "Enter your monthly income — we subtract EMIs, kameti and recurring bills to show what's truly free to spend.",
  },
  flex_set_income: { ur: "Income set karo", en: "Set income" },
  flex_income_label: { ur: "Mahana income", en: "Monthly income" },
  flex_income_hint: {
    ur: "Sirf aap ke phone par save hota hai — kabhi bhi badal do.",
    en: "Saved only on this phone — change it anytime.",
  },
  flex_left_of: { ur: "{total} flex mein se", en: "of {total} flex" },
  flex_income_word: { ur: "Income", en: "Income" },
  flex_spent_word: { ur: "Kharch", en: "Spent" },
  flex_part_recurring: { ur: "Recurring", en: "Recurring" },
  flex_low_hint: { ur: "Thora bacha hai — aaram se.", en: "Running low — go easy." },
  flex_out_hint: { ur: "Is mahine ka flex khatam.", en: "Flex is used up for this month." },
  flex_save_income: { ur: "Save karo", en: "Save" },
  flex_remove: { ur: "Income hatao", en: "Remove income" },
  flex_edit_income: { ur: "Income badlo", en: "Edit income" },

  // ── Weekly "Hisaab check" ritual ──
  check_entry_title: { ur: "Hisaab check", en: "Hisaab check" },
  check_entry_never: { ur: "5 minute — pehla check karo", en: "5 minutes — do your first check" },
  check_entry_today: { ur: "Aaj ho gaya — zabardast!", en: "Done today — nicely done!" },
  check_entry_days: { ur: "{d} din pehle kiya tha", en: "Last done {d} days ago" },
  check_step_flow: { ur: "Lena-dena", en: "Flow" },
  check_step_people: { ur: "Log", en: "People" },
  check_step_week: { ur: "Hafta", en: "Week" },
  check_step_action: { ur: "Kaam", en: "Action" },
  check_flow_title: { ur: "Pichle 7 din", en: "The last 7 days" },
  check_flow_sub: {
    ur: "Sirf asal aana-jaana — transfer aur shuffling nahi ginte.",
    en: "Real money in and out — transfers and shuffling don't count.",
  },
  check_in_label: { ur: "Aaya", en: "Came in" },
  check_out_label: { ur: "Gaya", en: "Went out" },
  check_people_title: { ur: "Log aur udhaar", en: "People & udhaar" },
  check_receivable: { ur: "Lena hai", en: "To receive" },
  check_payable: { ur: "Dena hai", en: "To pay" },
  check_since_last: { ur: "pichle check se", en: "since last check" },
  check_first_time: {
    ur: "Pehla check — agli baar farq bhi nazar aayega.",
    en: "First check — next time you'll see what changed.",
  },
  check_no_change: { ur: "Pichle check se koi tabdeeli nahi.", en: "No change since your last check." },
  check_week_title: { ur: "Aane wala hafta", en: "The week ahead" },
  check_week_clear: { ur: "Is hafte kuch due nahi — sukoon.", en: "Nothing due this week — sukoon." },
  check_action_title: { ur: "Aik kaam", en: "One action" },
  check_action_body: {
    ur: "{name} ne {amount} dena hai — {days} din se chal raha hai.",
    en: "{name} owes you {amount} — open for {days} days.",
  },
  check_action_remind: { ur: "WhatsApp par yaad dilao", en: "Remind on WhatsApp" },
  check_action_none: {
    ur: "Koi purana udhaar nahi latak raha — sab fresh hai.",
    en: "No long-standing udhaar — everything's fresh.",
  },
  check_done_title: { ur: "Hisaab saaf hai ✓", en: "All squared up ✓" },
  check_done_body: { ur: "Check ho gaya. Agle hafte milte hain.", en: "Check done. See you next week." },
  check_next: { ur: "Aage", en: "Next" },
  check_back: { ur: "Wapas", en: "Back" },
  check_finish: { ur: "Ho gaya", en: "Done" },

  // ── Needs-action queue (Home row + Inbox "To-do" tab) ──
  home_action_one: { ur: "1 kaam pending", en: "1 thing needs action" },
  home_action_many: { ur: "{n} kaam pending", en: "{n} things need action" },
  home_action_sub: { ur: "EMI, recurring, kameti — sab aik jagah", en: "EMIs, recurring, kameti — one queue" },
  ltr_tab_action: { ur: "Kaam", en: "To-do" },
  ltr_action_hint: {
    ur: "Jo cheezein aap ke haath ka intezaar kar rahi hain — kar do, list saaf.",
    en: "Things waiting on you — do them and the list clears.",
  },
  inbox_empty_action_title: { ur: "Sab clear hai ✓", en: "All clear ✓" },
  inbox_empty_action_desc: { ur: "Koi kaam pending nahi. Hisaab saaf.", en: "Nothing needs your action. Hisaab saaf." },
  inbox_empty_action_cta: { ur: "Home par jao", en: "Go to Home" },
  check_entry_days_one: { ur: "1 din pehle kiya tha", en: "Last done 1 day ago" },
  // Broad on purpose: the bucket also holds schedule-less udhaar repayments.
  flex_part_emi: { ur: "Qarz/EMI", en: "Loans/EMI" },
  // To-do card text (structured content from inboxInfo.ts, worded here).
  todo_emi_title_one: { ur: "EMI reh gayi · {name}", en: "EMI overdue · {name}" },
  todo_emi_title_many: { ur: "{n} EMIs reh gayin · {name}", en: "{n} EMIs overdue · {name}" },
  todo_emi_body_pay: { ur: "{amount} dena hai · {d} din late", en: "{amount} to pay · {d}d late" },
  todo_emi_body_collect: { ur: "{amount} lena hai · {d} din late", en: "{amount} to collect · {d}d late" },
  todo_recurring_title: { ur: "{label} ki date nikal gayi", en: "{label} missed its date" },
  todo_recurring_body: { ur: "{amount} · due tha {date}", en: "{amount} · was due {date}" },
  todo_kameti_title_one: { ur: "{name} · round {r} ki collection", en: "{name} · round {r} collection" },
  todo_kameti_title_many: { ur: "{name} · {k} rounds adhoore", en: "{name} · {k} rounds incomplete" },
  todo_kameti_body: { ur: "{paid}/{n} ne diya · {amount} fi member", en: "{paid}/{n} paid · {amount} each" },
  todo_uncat_title: { ur: "Bina category kharcha", en: "Uncategorised expense" },
  // Paid-state praise: a card bill cleared before its due day.
  tw_cleared: { ur: "Bill saaf — {n} din pehle ✓", en: "Bill cleared — {n}d early ✓" },
  tw_cleared_today: { ur: "Bill saaf — ain waqt par ✓", en: "Bill cleared — right on time ✓" },
  // One-tap category suggestion on the To-do queue.
  todo_uncat_suggest: { ur: "{category} mein daal dein?", en: "File under {category}?" },
  todo_uncat_filed: { ur: "{category} mein file ho gaya", en: "Filed under {category}" },
  // Android payment reminders (notification bodies via tStatic).
  settings_reminders: { ur: "Payment yaad-dahani", en: "Payment reminders" },
  settings_reminders_desc: {
    ur: "Card bill, EMI aur recurring — sirf jab kuch sach mein due ho.",
    en: "Card bills, EMIs and recurring — only when something is actually due.",
  },
  settings_reminders_denied: {
    ur: "Notification ki ijazat nahi mili — phone ki settings se allow karein.",
    en: "Notification permission was denied — allow it in your phone settings.",
  },
  // Contextual notification-permission ask (NotificationPermissionPrompt),
  // shown at high-intent moments instead of only the buried Settings toggle.
  notif_prompt_title: {
    ur: "Is qarz ki yaad-dahani chahiye?",
    en: "Want a reminder for this loan?",
  },
  notif_prompt_body: {
    ur: "Hisaab aapko due date se pehle yaad dila sakta hai — sirf jab kuch sach mein due ho.",
    en: "Hisaab can nudge you before this is due — only when something's actually due.",
  },
  notif_prompt_allow: { ur: "Reminders On Karein", en: "Turn On Reminders" },
  notif_prompt_not_now: { ur: "Abhi Nahi", en: "Not Now" },
  notif_bill_in: { ur: "Bill {d} din mein due — {amount}", en: "Bill due in {d} days — {amount}" },
  notif_bill_tomorrow: { ur: "Bill kal due hai — {amount}", en: "Bill due tomorrow — {amount}" },
  notif_bill_today: { ur: "Bill aaj due hai — {amount}", en: "Bill due today — {amount}" },
  notif_emi_tomorrow: { ur: "EMI #{n} kal due — {amount}", en: "EMI #{n} due tomorrow — {amount}" },
  notif_emi_today: { ur: "EMI #{n} aaj due — {amount}", en: "EMI #{n} due today — {amount}" },
  notif_recurring_today: {
    ur: "Aaj due — {amount}. Hisaab mein confirm karein.",
    en: "Due today — {amount}. Confirm it in Hisaab.",
  },
  notif_kameti_round: { ur: "Round {r} aaj — {amount} fi member", en: "Round {r} today — {amount} each" },
  // Contacts merge + archive.
  merge_button: { ur: "Kisi aur contact mein merge karo", en: "Merge into another contact" },
  merge_pick_title: { ur: "Kis mein merge karein?", en: "Merge into which contact?" },
  merge_pick_desc: {
    ur: "“{source}” ke saare loans aur entries chune gaye contact mein chale jayenge, phir yeh contact archive ho jayega.",
    en: "Every loan and entry of “{source}” will move to the contact you pick, then this contact is archived.",
  },
  merge_confirm_title: { ur: "{target} mein merge karein?", en: "Merge into {target}?" },
  merge_confirm_body: {
    ur: "“{source}” ki poori history “{target}” mein chali jayegi. Yeh wapas nahi hota — sirf source contact archive se wapas aa sakta hai.",
    en: "The full history of “{source}” moves to “{target}”. This can't be un-merged — only the source contact can be restored from the archive.",
  },
  merge_cta: { ur: "Merge karo", en: "Merge" },
  merge_done: { ur: "{target} mein merge ho gaya", en: "Merged into {target}" },
  merge_done_sub: { ur: "{n} loans aur {m} entries move hui", en: "{n} loans and {m} entries moved" },
  contacts_archived_toggle: { ur: "Archived contacts", en: "Archived contacts" },
  contacts_archived_empty: { ur: "Koi archived contact nahi.", en: "No archived contacts." },
  contacts_archived_error: {
    ur: "Archived contacts load nahi ho sake — dobara koshish karein.",
    en: "Couldn't load archived contacts — try again.",
  },
  contacts_unarchive: { ur: "Wapas lao", en: "Restore" },
  contacts_unarchive_done: { ur: "{name} wapas aa gaya", en: "{name} restored" },
  contacts_unarchive_gone: {
    ur: "Yeh contact pehle hi wapas aa chuka hai.",
    en: "This contact was already restored elsewhere.",
  },
  contacts_unarchive_dup_title: {
    ur: "{name} wapas laayein?",
    en: "Restore {name}?",
  },
  merge_pick_empty: {
    ur: "Merge ke liye koi aur contact nahi.",
    en: "No other contact to merge into.",
  },
  merge_err_not_found: {
    ur: "Yeh contact merge ke liye available nahi.",
    en: "That contact isn't available to merge.",
  },
  merge_err_linked: {
    ur: "Linked contact merge nahi ho sakta — duplicates ko US MEIN merge karein.",
    en: "A linked contact can't be merged away — merge duplicates INTO it instead.",
  },
  merge_err_same: {
    ur: "Do alag contacts chunein.",
    en: "Pick two different contacts.",
  },
  merge_err_generic: {
    ur: "Merge nahi ho saka — dobara koshish karein.",
    en: "Couldn't merge these contacts — try again.",
  },
  merge_err_migration: {
    ur: "Merge ke liye database update chahiye — SQL migration apply karein.",
    en: "Merge needs a database update — apply the SQL migration first.",
  },
  // Cleared-card praise (Inbox Info tab — bilingual like its This-week sibling).
  info_cc_cleared_early: { ur: "{name} ka bill saaf — {d} din pehle ✓", en: "{name} bill cleared — {d}d early ✓" },
  info_cc_cleared_ontime: { ur: "{name} ka bill saaf — ain waqt par ✓", en: "{name} bill cleared right on time ✓" },
  info_cc_cleared_body: { ur: "Is cycle kuch due nahi — zabardast.", en: "Nothing due this cycle — nicely done." },
  // Statement-native cash-advance instalments.
  emi_statement_anchored: {
    ur: "Har mahine card ki statement ({day}) par installment aayegi.",
    en: "Each instalment lands on the card's statement — the {day} of the month.",
  },
  // Per-card re-anchor migration.
  reanchor_title: { ur: "Instalment plan update", en: "Instalment plan update" },
  reanchor_body: {
    ur: "Is card ki cash-advance installments statement day ({day}) par shift ho sakti hain — taake aik hi bill sab cover kare. Sirf dates badlengi, koi raqam nahi.",
    en: "This card's cash-advance instalments can move onto its statement day (the {day}) so one bill covers them. Only the dates change — nothing owed changes.",
  },
  reanchor_cta: { ur: "Align karo", en: "Align" },
  reanchor_working: { ur: "Ho raha hai…", en: "Aligning…" },
  reanchor_done: { ur: "{n} plan align ho gaye", en: "Aligned {n} instalment plan(s)" },
  reanchor_none: { ur: "Sab pehle se aligned hain", en: "Already aligned" },
  // Credit-card billing cycle (statement-close day + payment-due day).
  cc_cycle_title: { ur: "Billing cycle", en: "Billing cycle" },
  cc_cycle_sub: {
    ur: "Statement kab band hoti hai aur payment kab due hai — taake reminder sahi waqt par aaye.",
    en: "When your statement closes and when payment's due — so reminders land at the right time.",
  },
  cc_cycle_close: { ur: "Statement band", en: "Statement closes" },
  cc_cycle_due: { ur: "Payment due", en: "Payment due" },
  cc_cycle_gap: { ur: "~{n} din", en: "~{n} days to pay" },
  cc_cycle_gap_one: { ur: "~1 din", en: "~1 day to pay" },
  // Cash-advance plan summary (on the card page).
  ca_plans_title: { ur: "Instalment plans", en: "Instalment plans" },
  ca_taken_on: { ur: "Liya: {date}", en: "Taken {date}" },
  ca_plan_count: { ur: "{n} qistein", en: "{n} instalments" },
  ca_paid_progress: { ur: "{p}/{n} ada — {amount}", en: "{p} of {n} paid — {amount}" },
  ca_paid_plain: { ur: "{amount} ada ho chuka", en: "{amount} paid" },
  ca_remaining: { ur: "{amount} baaki", en: "{amount} left" },
  ca_next_instalment: { ur: "Agli qist: {amount} · {date}", en: "Next instalment: {amount} · {date}" },
  cc_cycle_closes_on: { ur: "Band: {d}", en: "Closes {d}" },
  cc_cycle_due_on: { ur: "Due: {d}", en: "Due {d}" },
  cc_cycle_reassure: {
    ur: "Hum {d} se thora pehle yaad dila denge — kabhi baad mein nahi.",
    en: "We'll nudge you a few days before the {d} — never after.",
  },
  // Card statement breakdown.
  cc_statement_title: { ur: "Statement — is mahine", en: "Statement — this month" },
  cc_statement_purchases: { ur: "Kharchay + baaki", en: "Purchases + carried" },
  cc_statement_instalment: { ur: "Is cycle ki installment", en: "This cycle's instalment" },
  cc_statement_total_balance: { ur: "Total balance", en: "Total balance" },

  // ── Group consent, archive & lifecycle (audit 2026-09 P0 client wiring) ──
  // Companion copy for supabase-migration-audit-p0-consent-guards.sql,
  // -group-deletion-guard.sql, -account-deletion.sql and -join-abuse-limits.sql.

  // Invite-link redemption failures (accept_group_invite status vocabulary).
  invite_error_not_found: {
    ur: "Ye invite link ab kaam nahi karti — expire ho gayi ya wapas le li gayi. Owner se nai link mango.",
    en: "This invite link no longer works — it expired or was withdrawn. Ask the group owner for a fresh one.",
  },
  invite_error_group_gone: {
    ur: "Jis group ki ye invite thi woh ab mojood nahi.",
    en: "The group this invite pointed to no longer exists.",
  },
  invite_error_rate_limited: {
    ur: "Bohat zyada koshishein. 15 minute ruk kar dobara try karo.",
    en: "Too many attempts. Wait 15 minutes and try again.",
  },
  invite_fail_title_invalid: { ur: "Invite link kaam nahi kar rahi", en: "Invite link not valid" },
  invite_fail_title_group_gone: { ur: "Group mojood nahi", en: "Group no longer exists" },
  invite_fail_title_rate_limited: { ur: "Thora ruk jayein", en: "Too many attempts" },
  invite_fail_title_auth: { ur: "Pehle sign in karein", en: "Sign in first" },
  invite_fail_title_network: { ur: "Connection ka masla", en: "Connection problem" },
  invite_fail_title_unknown: { ur: "Group join nahi ho saka", en: "Could not join this group" },
  invite_page_intro: {
    ur: "Ye invite aap ke account ko aik shared Hisaab group se joRegi aur har tabdeeli ki khabar degi.",
    en: "This invite will connect your account to a shared Hisaab group and keep you updated on every change.",
  },
  invite_page_joined_title: { ur: "Aap shaamil ho gaye", en: "You are in" },
  invite_page_joined_body: {
    ur: "Group khul raha hai — kharchay, tabdeeliyan aur settlements sab yahan.",
    en: "Opening the group now so you can see expenses, edits, deletes, and settlements.",
  },
  invite_page_title: { ur: "Shared group join karein", en: "Join shared group" },
  invite_page_next_title: { ur: "Aage kya hoga", en: "What happens next" },
  invite_page_next_body: {
    ur: "Aap group ke connected member ban jayenge aur jab bhi koi kharcha add, edit, delete ya settle karega, aap ko pata chalega.",
    en: "You will be attached to the group as a connected member and receive in-app updates whenever someone adds, edits, deletes, or settles an expense.",
  },
  invite_page_go_home: { ur: "Home jayein", en: "Go home" },
  invite_page_try_again: { ur: "Dobara koshish", en: "Try again" },
  invite_page_joining: { ur: "Join ho raha hai...", en: "Joining..." },
  invite_page_opening: { ur: "Khul raha hai...", en: "Opening..." },
  invite_page_join_cta: { ur: "Group join karein", en: "Join group" },

  // Pending group invitations — the invitee's Accept/Decline door.
  ginv_pending_heading: { ur: "Zeer-e-ghaur invitations", en: "Pending invitations" },
  ginv_pending_sub: {
    ur: "{name} ne aap ko bulaya hai. Jab tak aap qubool nahi karte, aap group mein nahi hain.",
    en: "{name} invited you. You are not in the group until you accept.",
  },
  ginv_accept: { ur: "Qubool karein", en: "Accept" },
  ginv_decline: { ur: "Mana karein", en: "Decline" },
  ginv_accepted: { ur: "Aap group mein shaamil ho gaye", en: "You joined the group" },
  ginv_declined: { ur: "Invitation mana kar di gayi", en: "Invitation declined" },
  ginv_accept_failed: { ur: "Invitation qubool nahi ho saki", en: "Could not accept this invitation" },
  ginv_decline_failed: { ur: "Invitation mana nahi ho saki", en: "Could not decline this invitation" },
  ginv_decline_confirm_title: { ur: "Ye invitation mana karein?", en: "Decline this invitation?" },
  ginv_decline_confirm_body: {
    ur: "Aap group mein shaamil nahi honge. Baad mein group code ya nai invite link se aa sakte hain.",
    en: "You won't join the group. You can still come in later with the group code or a fresh invite link.",
  },

  // Duplicate membership row (consent-guards §2.2, SQLSTATE 23505).
  grp_member_already_exists: {
    ur: "Ye shakhs pehle se is group mein hai (ya pehle invite ho chuka hai). Unhein group code bhejein.",
    en: "This person already has a place in this group (or was invited before). Share the group code with them instead.",
  },

  // Group delete guard (group-deletion-guard.sql §2).
  grp_del_blocked_members_title: { ur: "Ye group delete nahi ho sakta", en: "This group can't be deleted" },
  grp_del_blocked_members_body: {
    ur: "Is group mein aur log bhi shaamil hain. Delete karne se un ke kharchay aur settlements bhi mit jayenge. Iske bajaye group archive karein.",
    en: "Other people are still in this group. Deleting it would erase their expenses and settlements too. Archive it instead.",
  },
  grp_del_blocked_balances_title: { ur: "Pehle hisaab barabar karein", en: "Settle the balances first" },
  grp_del_blocked_balances_body: {
    ur: "Is group mein abhi hisaab barabar nahi hua. Pehle settle karein, ya group archive kar dein taake record mehfooz rahe.",
    en: "Some balances in this group are still unsettled. Settle them first, or archive the group to keep the record intact.",
  },
  grp_del_archive_cta: { ur: "Archive karein", en: "Archive instead" },
  grp_del_failed: { ur: "Group delete nahi ho saka", en: "Could not delete this group" },

  // Archive / reopen.
  grp_archive_action: { ur: "Group archive karein", en: "Archive group" },
  grp_unarchive_action: { ur: "Group dobara kholein", en: "Reopen group" },
  grp_archive_confirm_title: { ur: "Ye group archive karein?", en: "Archive this group?" },
  grp_archive_confirm_body: {
    ur: "Sab kuch nazar aata rahega, magar naye kharchay, settlements aur naye members band ho jayenge. Aap jab chahein dobara khol sakte hain.",
    en: "Everything stays visible, but no new expenses, settlements or members. You can reopen it whenever you like.",
  },
  grp_archived_banner_title: { ur: "Ye group archive shuda hai", en: "This group is archived" },
  grp_archived_banner_body: {
    ur: "Purana record sab ke liye mehfooz hai. Naya kuch daalne ke liye owner ko group dobara kholna hoga.",
    en: "The record stays readable for everyone. The owner must reopen it to record anything new.",
  },
  grp_archived_tag: { ur: "Archive shuda", en: "Archived" },
  grp_archived_section: { ur: "Archive shuda", en: "Archived" },
  grp_archived_done: { ur: "Group archive ho gaya", en: "Group archived" },
  grp_unarchived_done: { ur: "Group dobara khul gaya", en: "Group reopened" },
  grp_archive_failed: { ur: "Group archive nahi ho saka", en: "Could not archive this group" },
  grp_unarchive_failed: { ur: "Group dobara khul nahi saka", en: "Could not reopen this group" },

  // Ownership transfer — the escape hatch for OWNED_GROUPS_WITH_MEMBERS and
  // leave_group's ONLY_OWNER_ADMIN.
  grp_transfer_action: { ur: "Kisi aur ko admin banayein", en: "Assign another admin" },
  grp_transfer_title: { ur: "Naya admin chunein", en: "Choose the new admin" },
  grp_transfer_body: {
    ur: "Sirf woh members chun sakte hain jo Hisaab par is group mein shaamil ho chuke hain. Iske baad aap aam member ban jayenge.",
    en: "Only members who have joined this group on Hisaab can take it over. You become a regular member afterwards.",
  },
  grp_transfer_none: {
    ur: "Abhi koi aisa member nahi jo group ka admin ban sake. Pehle kisi ko join karwayein.",
    en: "Nobody in this group can take it over yet. Get someone to join first.",
  },
  grp_transfer_done: { ur: "Group ki zimmedari transfer ho gayi", en: "Ownership transferred" },
  grp_transfer_failed: { ur: "Zimmedari transfer nahi ho saki", en: "Could not transfer ownership" },

  // Join code rotation + expiry (join-abuse-limits.sql SECTION 2).
  grp_code_refresh: { ur: "Naya code", en: "Refresh code" },
  grp_code_expires: { ur: "{date} tak chalega", en: "Works until {date}" },
  grp_code_expired: { ur: "Code expire ho chuka — naya banayein", en: "Code expired — refresh it" },
  grp_code_refreshed: { ur: "Naya group code ban gaya", en: "New group code created" },
  grp_code_refresh_sub: {
    ur: "Purana code ab kaam nahi karega. Naya code share karein.",
    en: "The old code stops working. Share the new one.",
  },
  grp_code_refresh_failed: { ur: "Naya code nahi ban saka", en: "Could not refresh the code" },

  // Group activity feed — the four new group_event types.
  gev_group_archived: { ur: "Group archive kiya gaya", en: "Group archived" },
  gev_group_unarchived: { ur: "Group dobara khola gaya", en: "Group reopened" },
  gev_member_account_deleted: { ur: "Member ka account delete ho gaya", en: "Member deleted their account" },
  gev_ownership_transferred: { ur: "Group ki zimmedari badli", en: "Ownership transferred" },

  // Archive notifications (notify_group_archive_state templates).
  ntf_group_archived_title: { ur: "{group} archive ho gaya", en: "{group} was archived" },
  ntf_group_archived_body: {
    ur: "{actor} ne {group} archive kar diya. Sab kuch nazar aayega, magar naya kuch add nahi hoga.",
    en: "{actor} archived {group}. It stays readable, but nothing new can be added.",
  },
  ntf_group_unarchived_title: { ur: "{group} dobara khul gaya", en: "{group} was reopened" },
  ntf_group_unarchived_body: {
    ur: "{actor} ne {group} dobara khol diya. Ab kharchay add ho sakte hain.",
    en: "{actor} reopened {group}. You can add expenses again.",
  },

  // A creator who has LEFT can no longer edit or delete even their own rows —
  // every group write path requires a connected membership.
  grp_left_readonly: {
    ur: "Aap is group se nikal chuke hain — yahan ke record ab sirf dekhne ke liye hain.",
    en: "You left this group, so its records are read-only for you.",
  },

  // ── Force-update gate (audit H9 / MF-12) ──────────────────────────────────
  // Shown by UpdateRequiredScreen when app_config.min_supported_version(_code)
  // is above this build. The server can override the body copy via
  // app_config.message_ur / message_en; these are the always-translated
  // fallback, so an operator raising the floor mid-incident never has to write
  // Roman Urdu under pressure. See src/lib/versionGate.ts.
  upd_required_title: { ur: "App Update Karein", en: "Update Hisaab" },
  upd_required_body: {
    ur: "Hisaab ka yeh version purana ho chuka hai aur ab server ke sath theek kaam nahi karega. Aage barhne ke liye update karein.",
    en: "This version of Hisaab is too old to work safely with the server. Update to continue.",
  },
  upd_required_safe: {
    ur: "Aap ka saara data mehfooz hai — update ke baad sab wahin milega.",
    en: "All your data is safe — it's all there after the update.",
  },
  upd_required_store: { ur: "Play Store se update karein", en: "Update from Play Store" },
  upd_required_reload: { ur: "App refresh karein", en: "Refresh the app" },
  upd_required_reload_hint: {
    ur: "Refresh ke baad bhi yehi screen aaye to browser band kar ke dobara kholein.",
    en: "If this screen comes back after refreshing, close the browser tab and reopen it.",
  },
  upd_required_version: { ur: "Aap ka version: {version}", en: "Your version: {version}" },

  // ── Privacy: anonymous usage stats (opt-in telemetry) + feedback ──────────
  // The consent copy must stay literally true: it is the user-facing half of
  // the PII policy enforced in src/lib/telemetryEvents.ts. If the event catalog
  // ever starts carrying something new, these strings change in the same PR.
  tlm_consent_title: { ur: "Hisaab behtar banane mein madad", en: "Help improve Hisaab" },
  tlm_consent_sub: {
    ur: "Gumnaam usage stats — default off",
    en: "Anonymous usage stats — off by default",
  },
  tlm_consent_body: {
    ur: "On karne par hamein sirf yeh pata chalta hai ke kaun se feature kitne log use karte hain, taake kharaab hisson ko theek kar sakein.",
    en: "Turning this on tells us only which features people actually use, so we can fix the parts that don't work.",
  },
  tlm_consent_collected_title: { ur: "Kya bheja jata hai", en: "What is sent" },
  tlm_consent_collected_1: {
    ur: "Kaun sa screen ya action hua (misal: “group banaya”)",
    en: "Which screen or action happened (e.g. \"created a group\")",
  },
  tlm_consent_collected_2: {
    ur: "App mode, zuban, aur currency ka code (PKR, AED)",
    en: "App mode, language, and the currency code (PKR, AED)",
  },
  tlm_consent_collected_3: {
    ur: "Aap ka gumnaam account ID — na naam, na email",
    en: "Your opaque account ID — no name, no email",
  },
  tlm_consent_never_title: { ur: "Kabhi nahi bheja jata", en: "Never sent" },
  tlm_consent_never_1: {
    ur: "Koi raqam, balance ya hisaab ka number",
    en: "No amounts, balances or figures",
  },
  tlm_consent_never_2: {
    ur: "Koi naam, phone number, note ya group/kameti ka naam",
    en: "No names, phone numbers, notes, or group/kameti names",
  },
  tlm_consent_never_3: {
    ur: "Na screen recording, na koi ad tracking. Data kabhi becha nahi jayega.",
    en: "No screen recording, no ad tracking. Your data is never sold.",
  },
  tlm_consent_off_note: {
    ur: "Band karte hi bhejna ruk jata hai aur is phone par jama shuda telemetry data mit jata hai.",
    en: "Turning it off stops sending immediately and clears the telemetry data stored on this device.",
  },
  tlm_consent_unavailable: {
    ur: "Is build mein usage stats bilkul band hain.",
    en: "Usage stats are fully disabled in this build.",
  },

  fbk_title: { ur: "Feedback bhejein", en: "Send feedback" },
  fbk_sub: {
    ur: "Kuch toota hua hai ya kuch chahiye? Seedha batayein.",
    en: "Something broken, or something missing? Tell us directly.",
  },
  fbk_whatsapp: { ur: "WhatsApp par bhejein", en: "Send on WhatsApp" },
  fbk_email: { ur: "Email karein", en: "Email us" },
  fbk_note_label: { ur: "Ya yahan likh lein", en: "Or jot it down here" },
  fbk_note_ph: {
    ur: "Kya behtar ho sakta hai?",
    en: "What could be better?",
  },
  fbk_note_local_only: {
    ur: "Yeh sirf is phone par mehfooz hai — bhejne ke liye upar WhatsApp ya email chunein.",
    en: "This is saved on this device only — use WhatsApp or email above to actually send it.",
  },
  fbk_note_saved: { ur: "Draft save ho gaya", en: "Draft saved" },
  fbk_prefill: {
    ur: "Salaam! Hisaab ke baare mein feedback:",
    en: "Hi! Feedback about Hisaab:",
  },
  fbk_email_subject: { ur: "Hisaab feedback", en: "Hisaab feedback" },
} as const;

type Key = keyof typeof S;
// Public alias so non-component modules (e.g. authErrorMap) can type i18n keys.
export type I18nKey = Key;

interface I18nState {
  lang: Language;
  setLang: (lang: Language) => void;
}

export const useI18nStore = create<I18nState>((set) => ({
  lang: (localStorage.getItem("hisaab_lang") as Language) || "en",
  setLang: (lang) => {
    localStorage.setItem("hisaab_lang", lang);
    set({ lang });
    // Scheduled Android reminders freeze their text at plan time — rebuild
    // so they arrive in the newly chosen language. Dynamic import: the
    // scheduler's planner statically imports THIS module. No-op on web.
    void import("./notificationScheduler")
      .then((m) => m.rescheduleNotifications({ force: true }))
      .catch(() => {});
  },
}));

export function useT() {
  const lang = useI18nStore((s) => s.lang);
  return (key: Key): string => {
    const entry = S[key];
    return entry ? entry[lang] : key;
  };
}

// Non-hook accessor for stores/libs that compose user-facing strings outside
// React (thrown guard errors, toasts built in async flows). Reads the live
// language from the store so the copy matches the UI.
export function tStatic(key: Key): string {
  const entry = S[key];
  return entry ? entry[useI18nStore.getState().lang] : key;
}
