<script setup lang="ts">
import { computed } from "vue";
import { useBolnaCall } from "./useBolnaCall";

const { state, error, muted, start, stop, setMuted } = useBolnaCall("/api/bolna-session");
const live = computed(() => ["connecting", "ringing", "active"].includes(state.value));
</script>

<template>
  <div>
    <button @click="live ? stop() : start()">{{ live ? "Hang up" : "Talk to our agent" }}</button>
    <button v-if="state === 'active'" @click="setMuted(!muted)">{{ muted ? "Unmute" : "Mute" }}</button>
    <p>{{ state }}</p>
    <p v-if="error" role="alert">{{ error.code }}: {{ error.message }}</p>
  </div>
</template>
