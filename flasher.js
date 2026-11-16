import "/lib/beer.min.js?v=openhop17";
import { createApp } from "/lib/vue.prod.min.js?v=openhop17";
import ReadMore from '/lib/overflow.vue.js?v=openhop17';
import { createSetup } from '/js/app.js?v=openhop17';
import { loadCatalog } from '/js/catalog.js?v=openhop17';

// Restore direct links after release discovery using the application's router.
const config = await loadCatalog();
createApp({ setup: createSetup(config), components: { ReadMore } }).mount('#app');
