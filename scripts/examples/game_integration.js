/**
 * Game Integration Example
 * 
 * This example demonstrates how to interact with game functions
 * through the Game API wrapper.
 * 
 * NOTE: This is a template. You need to implement the actual
 * game functions in src/game/api/game_wrap.cc
 */

import { ImGui } from 'imgui';

export function tick() {
  ImGui.Begin("Game Integration Example");
  
  ImGui.Text("Game API Integration");
  ImGui.Separator();
  
  // Example: Get local player
  try {
    const player = Game.getLocalPlayer();
    
    if (player) {
      ImGui.Text("Player Information:");
      ImGui.Indent();
      ImGui.Text(`Health: ${player.health}/${player.maxHealth}`);
      ImGui.Text(`Position: (${player.positionX.toFixed(2)}, ${player.positionY.toFixed(2)}, ${player.positionZ.toFixed(2)})`);
      ImGui.Unindent();
    } else {
      ImGui.TextColored([1, 0, 0, 1], "No player found");
    }
  } catch (e) {
    ImGui.TextColored([1, 1, 0, 1], "Game API not implemented yet");
    ImGui.Text("See src/game/api/game_wrap.cc");
  }
  
  ImGui.Separator();
  
  // Example: Get entity by ID
  if (ImGui.Button("Get Entity #1")) {
    try {
      const entity = Game.getEntityById(1);
      if (entity) {
        console.log("Entity found:", entity);
      } else {
        console.log("Entity not found");
      }
    } catch (e) {
      console.log("Game API not implemented yet");
    }
  }
  
  ImGui.End();
}

