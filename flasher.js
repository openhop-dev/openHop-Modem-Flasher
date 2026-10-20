import "/lib/beer.min.js?v=openhop16";
import { createApp } from "/lib/vue.prod.min.js?v=openhop16";
import ReadMore from '/lib/overflow.vue.js?v=openhop16';
import { createSetup } from '/js/app.js?v=openhop16';
import { loadCatalog } from '/js/catalog.js?v=openhop16';

// Restore direct links after release discovery using the application's router.
const config = await loadCatalog();
createApp({ setup: createSetup(config), components: { ReadMore } }).mount('#app');
