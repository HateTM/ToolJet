function systemPrompt(): string {
  return `You are an intelligent layout optimization assistant. Your task is to analyze component layouts inside a container and generate improved layout coordinates that eliminate overlaps while maintaining relative positioning as much as possible. You will receive data about a target component and its siblings, including their current positions, sizes, and spatial relationships. Your goal is to produce updated layout coordinates that resolve any overlapping issues while minimizing disruption to the overall design.`;
}

function taskPrompt(componentLayout, siblings) {
  return `
I need you to optimize the layout of UI components to eliminate overlaps. I'll provide you with data from a spatial analysis that includes information about a target component and its siblings, their positions, sizes, and relationships (like "overlap", "above", "below", "right", etc.).
The input data follows this format:

  "TargetComponent"
   {
    "id": "f1123596-7523-4dec-aedb-5ff031414ae6",
    "name": "ComponentName",
    "type": "ComponentType",
    "layout": {
      "top": 100,
      "left": 50,
      "width": 200,
      "height": 40
    }
  }
  "siblings": [
    {
      "id": "sibling-id-1",
      "parent": "parent-id",
      "name": "SiblingName1",
      "type": "SiblingType",
      "layout": {
        "top": 150,
        "left": 50,
        "width": 200,
        "height": 40
      },
      "position": "overlap",
      "distance": -1800
    },
    // Additional siblings with their positions and distances
  ]


INPUT DATA:

TargetComponent
${JSON.stringify(componentLayout)}

Siblings
${JSON.stringify(siblings)}

Please analyze the layout and generate updated coordinates that:

Eliminate all overlaps by repositioning components
Maintain the relative arrangement of components where possible (components that were to the right should generally stay to the right, etc.)
Prioritize moving components that are overlapping
Ensure all components remain within the parent container (dimensions provided)
Maintaining component size is not mandatory, but if a component is resized, it should be done proportionally. If parent width won't accommodate the things then instead of moving it in x axis, move it in y axis because tooljet has overflow y in container/parent component.

Return the new layout values in this format:
{
  "f1123596-7523-4dec-aedb-5ff031414ae6": {"top": 100, "left": 50, "width": 200, "height": 40},
  "sibling-id-1": {"top": 150, "left": 50, "width": 200, "height": 40},
  "sibling-id-2": {"top": 200, "left": 50, "width": 200, "height": 40}
}
Guidelines for layout adjustments:

Look for patterns in the current layout (alignment, spacing) and try to maintain them
When components overlap, prioritize moving the one that would cause the least disruption to the overall layout
Components in the same position category (e.g., all "below" components) should generally maintain their relationship to each other
Consider the semantic importance of components based on their type (buttons, inputs, labels, etc.)
If multiple solutions exist, choose the one that requires moving the fewest components or the smallest distance

**IMPORTANT**: The layout must be properly calculated and the sibling components must be reconciled with the target component. The layout should be optimized to ensure that all components are positioned correctly without any overlaps. There can be no overlaps, if multiple components need to be repositioned, move them. Always ensure that there is a gap of at least 10px bettween components which are repositioned. Remember to keepthe components in bounds along x axis only overflow along the Y axis.

The components are rectangular UI elements in a ToolJet application, and even a slight overlap is problematic. Please provide a complete solution that resolves all overlaps.

The output should be a JSON object with the updated layout values for each component, ensuring that all overlaps are resolved and the overall layout is optimized. The JSON object should not include any additional text or explanations and should not start with the word "JSON"

˚sOnly return the JSON response with the keys above, without any ˚stext or explanation. Do not include any code blocks or formatting in ˚sresponse. The response should be a valid JSON object with the specified ˚structure.

`;
}

export { systemPrompt, taskPrompt };
