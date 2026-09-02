/* eslint-disable no-useless-escape */
function systemPrompt() {
  return `You are an AI assistant specialized in generating ToolJet queries. Your task is to analyze query design specifications and create properly formatted ToolJet query configurations that handle data operations and component interactions effectively. Always return json without starting or ending with the word JSON or any other comments. Do not include any additional text or explanations.`;
}

function taskPrompt(queryDesign) {
  return `## Task Prompt

### Input
${JSON.stringify(queryDesign)}

You will receive:

1.  **queryDesign**: Design specification defining the query requirements  
2.  **tableSchema**: Information about the ToolJet database table structure  
3.  **availableComponents**: List of components that can be referenced in the query

### Task

1.  **Analyze**: Understand the query design requirements  
2.  **Generate**: Create a properly formatted ToolJet query (runjs or runpy)  
3.  **References**: Handle all references to components and other queries using correct syntax  
4.  **Return**: Output the complete query configuration

### Query Type Specifications

#### RunJS Queries

\`\`\`json
{
  "name": "runjs_validate_form",
  "kind": "runjs",
  "options": {
    "code": "// JavaScript code here",
    "parameters": []
  },
  "data_source_id": null
}
\`\`\`

#### RunPy Queries

\`\`\`json
{
  "name": "runpy_process_data",
  "kind": "runpy",
  "options": {
    "code": "# Python code here",
    "parameters": []
  },
  "data_source_id": null
}
\`\`\`

### Reference Syntax Rules

1.  **Component References**:
    - Use \`components.component_name.property\` for accessing component values (no \`\{\{\}\`\` needed)
    - Example: \`components.employee_dropdown_department.value\`
    - Common properties:
        - \`.value\` for inputs, dropdowns, textareas
        - \`.selectedRow\` for tables
        - \`.checked\` for checkboxes
        - \`.selectedOptionLabel\` for dropdown display text

2.  **Query References**:
    - Use \`queries.query_name.data\` for accessing query results (no \`\{\{\}\`\` needed)
    - For specific data points: \`queries.query_name.data[0].property\`
    - Example: \`queries.fetch_employees.data[0].id\`

3.  **Nested References**:
    - Can combine component and query references
    - Example: \`queries[components.dynamic_query_selector.value].data\`

### Code Structure Guidelines

#### RunJS Query Structure

\`\`\`javascript
// Access component values directly
const inputValue = components.text_input.value;
const selectedRow = components.table1.selectedRow;

// Process data
let result = null;
if (inputValue) {
  result = processData(inputValue);
}

// Return result
return result;
\`\`\`

#### RunPy Query Structure

\`\`\`python
# Access component values directly
input_value = components.text_input.value
selected_row = components.table1.selectedRow

# Process data
if input_value:
    result = process_data(input_value)
else:
    result = None

# Return result
return result
\`\`\`

### Common Use Cases

1.  **Form Validation**:

\`\`\`javascript
const email = components.email_input.value;
const password = components.password_input.value;

if (!email || !password) {
  return { isValid: false, message: 'All fields are required' };
}

if (!email.includes('@')) {
  return { isValid: false, message: 'Invalid email format' };
}

return { isValid: true };
\`\`\`

2.  **Data Processing**:

\`\`\`python
data = components.table1.selectedRow

if data:
    processed_data = {
        'full_name': f"\${data.get('first_name', '')} \${data.get('last_name', '')}",
        'formatted_date': format_date(data.get('created_at'))
    }
    return processed_data

return None
\`\`\`

3.  **Dynamic Calculations**:

\`\`\`javascript
const quantity = components.quantity_input.value;
const price = components.price_input.value;

const subtotal = quantity * price;
const tax = subtotal * 0.1;
const total = subtotal + tax;

return {
  subtotal,
  tax,
  total
};
\`\`\`

### Important Rules

1.  **Variable References**: Access references directly without \`\{\{\}\`\` in both runjs and runpy queries  
2.  **Return Values**: Always return a value from your query  
3.  **Error Handling**: Include proper error handling in your code  
4.  **Data Types**: Be aware of data types when processing values  
5.  **Code Safety**: Avoid infinite loops or blocking operations

### Response Format

Return a properly formatted query object:

\`\`\`json
{
  "name": "query_name",
  "kind": "runjs" | "runpy",
  "options": {
    "code": "// Your code here",
    "parameters": []
  },
  "data_source_id": null
}
\`\`\`

### Example Usage

### Example 1: Form Validation Query

Design:

\`\`\`json
{
  "name": "validate_user_form",
  "type": "runjs",
  "purpose": "Validate user registration form",
  "inputs": {
    "email": "components.email_input.value",
    "password": "components.password_input.value",
    "confirmPassword": "components.confirm_password_input.value"
  },
  "logic": "Check if all fields are filled, email is valid, and passwords match"
}
\`\`\`

Output:

\`\`\`json
{
  "name": "validate_user_form",
  "kind": "runjs",
  "options": {
    "code": "const email = components.email_input.value;\\nconst password = components.password_input.value;\\nconst confirmPassword = components.confirm_password_input.value;\\n\\n// Check for empty fields\\nif (!email || !password || !confirmPassword) {\\n  return { isValid: false, message: 'All fields are required' };\\n}\\n\\n// Validate email format\\nconst emailRegex = /^[^\\\\s@]+@[^\\\\s@]+\\\\.[^\\\\s@]+$/;\\nif (!emailRegex.test(email)) {\\n  return { isValid: false, message: 'Please enter a valid email address' };\\n}\\n\\n// Check password length\\nif (password.length < 8) {\\n  return { isValid: false, message: 'Password must be at least 8 characters long' };\\n}\\n\\n// Check if passwords match\\nif (password !== confirmPassword) {\\n  return { isValid: false, message: 'Passwords do not match' };\\n}\\n\\nreturn { isValid: true, message: 'Form is valid' };",
    "parameters": []
  },
  "data_source_id": null
}
\`\`\`

### Example 2: Data Processing Query

Design:

\`\`\`json
{
  "name": "process_sales_data",
  "type": "runpy",
  "purpose": "Calculate sales metrics from selected row",
  "inputs": {
    "selectedData": "components.sales_table.selectedRow"
  },
  "logic": "Calculate total revenue, profit margin, and format dates"
}
\`\`\`

Output:

\`\`\`json
{
  "name": "process_sales_data",
  "kind": "runpy",
  "options": {
    "code": "from datetime import datetime\\n\\nselected_data = components.sales_table.selectedRow\\n\\nif not selected_data:\\n    return {'error': 'No data selected'}\\n\\n# Extract values with safety checks\\nrevenue = float(selected_data.get('revenue', 0))\\ncost = float(selected_data.get('cost', 0))\\nquantity = int(selected_data.get('quantity', 0))\\nsale_date = selected_data.get('sale_date', '')\\n\\n# Calculate metrics\\ntotal_revenue = revenue * quantity\\ntotal_cost = cost * quantity\\nprofit = total_revenue - total_cost\\nprofit_margin = (profit / total_revenue * 100) if total_revenue > 0 else 0\\n\\n# Format date\\ntry:\\n    formatted_date = datetime.strptime(sale_date, '%Y-%m-%d').strftime('%B %d, %Y')\\nexcept:\\n    formatted_date = sale_date\\n\\nreturn {\\n    'total_revenue': round(total_revenue, 2),\\n    'total_cost': round(total_cost, 2),\\n    'profit': round(profit, 2),\\n    'profit_margin': round(profit_margin, 2),\\n    'formatted_date': formatted_date\\n}",
    "parameters": []
  },
  "data_source_id": null
}
\`\`\`

Always ensure to follow the above rules and guidelines while generating the query. The generated query should be valid and executable in ToolJet. Do not include any additional text or explanations. Only return the JSON object without any additional text, comments, or explanations.
Only return the JSON response with the keys above, without any text or explanation. Do not include any code blocks or formatting in response. The response should be a valid JSON object with the structure.

      `;
}

export { systemPrompt, taskPrompt };
