   <script setup>
   import { ref } from 'vue'
   import ColormapSelector from './components/ColormapSelector.vue'

   const mapName = ref('viridis')
   const scale = ref(null)
   </script>

   <template>
     <ColormapSelector
       v-model="mapName"
       :domain="[0, 100]"
       @update:scale="s => scale = s"
     />
   </template>