/**
 * Autosuggest feature quick verification script
 * Run this script in the browser developer tools for functionality verification
 *
 * Usage:
 * 1. Open Chrome DevTools (F12)
 * 2. Go to the Console tab
 * 3. Copy and paste this script into the console
 * 4. Press Enter to run
 */

// ============ 1. Verify Global Functions and APIs ============

console.group('🔍 1. global functions and API verify/validate');

// Check if getSelectedConfig exists
if (typeof window.getSelectedConfig === 'function') {
  console.log('✓ window.getSelectedConfig exists');
  const config = window.getSelectedConfig();
  console.log(`  current logged-in user: ${config?.username || 'N/A'}`);
  console.log(`  current logged-in email: ${config?.email || 'N/A'}`);
} else {
  console.warn('✗ window.getSelectedConfig undefined');
}

// Check IPC API
if (window.electronAPI?.getContacts) {
  console.log('✓ window.electronAPI.getContacts exists');
} else {
  console.warn('✗ window.electronAPI.getContacts undefined');
}

// Check the MailinkEmailCompose component
const emailComposeEl = document.querySelector('mailink-email-compose');
if (emailComposeEl) {
  console.log('✓ mailink-email-compose element exists');
  
  // Check necessary DOM elements
  const toChipsInput = emailComposeEl.querySelector('#toChipsInput');
  const toChipsSuggestions = emailComposeEl.querySelector('#toChipsSuggestions');
  
  if (toChipsInput) console.log('  ✓ toChipsInput DOM element exists');
  else console.warn('  ✗ toChipsInput DOM element missing');
  
  if (toChipsSuggestions) console.log('  ✓ toChipsSuggestions DOM element exists');
  else console.warn('  ✗ toChipsSuggestions DOM element missing');
} else {
  console.warn('✗ mailink-email-compose component not found');
}

console.groupEnd();

// ============ 2. Verify Internal State of Component ============

console.group('🔍 2. component internal state validation');

if (emailComposeEl) {
  // Access the component's private properties (for debugging only)
  console.log('component property check:');
  console.log('  _toChips:', emailComposeEl._toChips || 'not initialized');
  console.log('  _allContacts:', emailComposeEl._allContacts || 'not initialized');
  console.log('  _contactsLoaded:', emailComposeEl._contactsLoaded || false);
  console.log('  _toSuggestions:', emailComposeEl._toSuggestions || 'not initialized');
  console.log('  _currentLoginUsername:', emailComposeEl._currentLoginUsername || 'not set');
  console.log('  _toInputDebounceTimer:', emailComposeEl._toInputDebounceTimer || 'not enabled');
  
  // Check if the method exists
  console.log('\nmethod check:');
  const methods = [
    '_handleToChipsInputDebounce',
    '_handleToChipsInputWithSearch',
    '_loadAllContacts',
    '_filterAndSortContacts',
    '_showToSuggestionsEnhanced',
    '_initializeSuggestions'
  ];
  
  methods.forEach(method => {
    if (typeof emailComposeEl[method] === 'function') {
      console.log(`  ✓ ${method} exists`);
    } else {
      console.warn(`  ✗ ${method} missing`);
    }
  });
} else {
  console.warn('component not found, unable to verify internal state');
}

console.groupEnd();

// ============ 3. Simulated Test Scenarios ============

console.group('🔍 3. manual test steps');

console.log('🎯 test scenario 1: enter search term');
console.log('step:');
console.log('1. in/at "recipient" enter any character in the input box（such as "user"）');
console.log('2. wait 300ms debounce time');
console.log('3. observe whether the dropdown shows related contacts');
console.log('expected: matching contact suggestions appear');

console.log('\n🎯 test scenario 2: keyboard navigation');
console.log('step:');
console.log('1. input makes suggestions appear');
console.log('2. press up/navigate with down arrow key');
console.log('3. press Enter select');
console.log('expected: selected contact email becomes chip');

console.log('\n🎯 test scenario 3: mouse click');
console.log('step:');
console.log('1. input makes suggestions appear');
console.log('2. click a suggestion with the mouse');
console.log('expected: the contact is added as chip');

console.log('\n🎯 test scenario 4: duplicate check');
console.log('step:');
console.log('1. add a contact as chip');
console.log('2. search for the contact again');
console.log('expected: the contact does not appear in suggestions');

console.groupEnd();

// ============ 4. Debugging Utility Functions ============

console.group('🔧 debug utility functions');

window.debugAutosuggest = {
  // Get current status
  getState: () => {
    const el = document.querySelector('mailink-email-compose');
    if (!el) return { error: 'Component not found' };
    return {
      toChips: el._toChips,
      allContacts: el._allContacts,
      contactsLoaded: el._contactsLoaded,
      toSuggestions: el._toSuggestions,
      currentLoginUsername: el._currentLoginUsername
    };
  },

  // Simulated input
  simulateInput: async (text) => {
    const el = document.querySelector('mailink-email-compose');
    if (!el) {
      console.error('Component not found');
      return;
    }
    
    const input = el.querySelector('#toChipsInput');
    if (!input) {
      console.error('Input element not found');
      return;
    }
    
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    
    // Wait for debounce to complete (300ms safety margin)
    await new Promise(resolve => setTimeout(resolve, 400));
    
    console.log('current suggestions:', el._toSuggestions);
    return el._toSuggestions;
  },

  // Simulate selecting a contact
  selectContact: (index) => {
    const el = document.querySelector('mailink-email-compose');
    const suggestions = el?.querySelector('#toChipsSuggestions');
    if (!suggestions) {
      console.error('Suggestions container not found');
      return;
    }
    
    const items = suggestions.querySelectorAll('.email-compose-suggestion-item');
    if (index >= items.length) {
      console.error(`Index out of range (max: ${items.length - 1})`);
      return;
    }
    
    items[index].click();
    console.log(`✓ selected item # ${index + 1} th suggestion`);
  },

  // Load contacts
  loadContacts: async () => {
    const el = document.querySelector('mailink-email-compose');
    if (!el) {
      console.error('Component not found');
      return;
    }
    
    console.log('loading...');
    await el._loadAllContacts();
    console.log(`✓ loaded ${el._allContacts.length} contacts`);
    return el._allContacts;
  },

  // Test filter
  testFilter: (searchText) => {
    const el = document.querySelector('mailink-email-compose');
    if (!el) {
      console.error('Component not found');
      return;
    }
    
    const results = el._filterAndSortContacts(searchText);
    console.log(`search "${searchText}" results:`, results);
    return results;
  }
};

console.log('✓ debug tools loaded into window.debugAutosuggest');
console.log('available methods:');
console.log('  - debugAutosuggest.getState()         // get current state');
console.log('  - debugAutosuggest.simulateInput(text) // simulate user input');
console.log('  - debugAutosuggest.selectContact(idx)  // select a contact from suggestions');
console.log('  - debugAutosuggest.loadContacts()      // manually load contacts');
console.log('  - debugAutosuggest.testFilter(text)    // test filtering logic');

console.groupEnd();

// ============ 5. Quick Health Check ============

console.group('🏥 health check summary');

let checksPassed = 0;
let checksFailed = 0;

const checks = [
  { name: 'getSelectedConfig', test: () => typeof window.getSelectedConfig === 'function' },
  { name: 'IPC getContacts', test: () => !!window.electronAPI?.getContacts },
  { name: 'Component element', test: () => !!document.querySelector('mailink-email-compose') },
  { name: 'toChipsInput', test: () => !!document.querySelector('#toChipsInput') },
  { name: 'toChipsSuggestions', test: () => !!document.querySelector('#toChipsSuggestions') }
];

checks.forEach(({ name, test }) => {
  if (test()) {
    console.log(`✓ ${name}`);
    checksPassed++;
  } else {
    console.warn(`✗ ${name}`);
    checksFailed++;
  }
});

console.log(`\ntotal: ${checksPassed} via, ${checksFailed} failed`);

if (checksFailed === 0) {
  console.log('✅ all health checks passed!system ready.');
} else {
  console.warn('⚠️ missing components or API, autocomplete may not work properly.');
}

console.groupEnd();

console.log('\n💡 prompt/tip: input debugAutosuggest.simulateInput("test") run quick test');
