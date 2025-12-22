/**
 * Basic UI Example
 * 
 * This example demonstrates how to create a simple ImGui window
 * with various UI elements.
 */

import { ImGui } from 'imgui';

let counter = 0;
let text = "Hello World";
let sliderValue = 0.5;
let checkboxValue = false;

export function tick() {
  // Create a window
  ImGui.Begin("Basic UI Example");
  
  // Display text
  ImGui.Text("Welcome to the Game Modding Framework!");
  ImGui.Separator();
  
  // Button
  if (ImGui.Button("Click Me!")) {
    counter++;
    console.log(`Button clicked ${counter} times`);
  }
  ImGui.SameLine();
  ImGui.Text(`Clicked: ${counter} times`);
  
  // Slider
  const [sliderChanged, newSliderValue] = ImGui.SliderFloat("Slider", sliderValue, 0.0, 1.0);
  if (sliderChanged) {
    sliderValue = newSliderValue;
  }
  
  // Checkbox
  const [checkboxChanged, newCheckboxValue] = ImGui.Checkbox("Enable Feature", checkboxValue);
  if (checkboxChanged) {
    checkboxValue = newCheckboxValue;
    console.log(`Feature ${checkboxValue ? 'enabled' : 'disabled'}`);
  }
  
  // Input text
  const [textChanged, newText] = ImGui.InputText("Text Input", text, 256);
  if (textChanged) {
    text = newText;
  }
  
  // Color button
  if (ImGui.ColorButton("Color", [1.0, 0.0, 0.0, 1.0], 0, [40, 40])) {
    console.log("Color button clicked!");
  }
  
  ImGui.Separator();
  ImGui.Text("Press HOME to toggle console");
  ImGui.Text("Press END to reload scripts");
  
  ImGui.End();
}

