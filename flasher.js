import "/lib/beer.min.js?v=openhop15";
import { createApp } from "/lib/vue.prod.min.js?v=openhop15";
import ReadMore from '/lib/overflow.vue.js?v=openhop15';
import { createSetup } from '/js/app.js?v=openhop15';
import { loadCatalog } from '/js/catalog.js?v=openhop15';

// Restore direct links after release discovery using the application's router.
const config = await loadCatalog();
createApp({ setup: createSetup(config), components: { ReadMore } }).mount('#app');
