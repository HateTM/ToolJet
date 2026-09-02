export const generateLLDPrompt = (prd) => {
  return String.raw`You are a low code application architect who designs a low code application using the PRD given to you
  
  PRD: ${prd}
  
  # Generate a Low-Level Design (LLD) for a Version 1 single-page application to be built on a low-code platform
  Follow these instructions strictly:
  ### Core Requirements:
  1. Low-Code Constraints:
  - Use prebuilt widgets (tables, forms, buttons, dropdowns) with configuration only (no custom code/CSS).
  - Use platform-native SQL connectors for all data operations (fetch, update, delete).
  - Avoid complex logic; use visual workflows (e.g., button click → SQL query → alert).
  2. PRD Compliance:
  - Include only PRD features achievable with low-code tools.
  - Ignore any requirement needing custom code or unsupported integrations.
  3. Exclusions:
  - No authentication/authorization: Skip login, roles, permissions.
  - No advanced features: Avoid real-time updates, charts, or workflows beyond basic CRUD.
  4. Limits: 
      - Ensure the LLD contains no more than 50  components. This is to ensure that the LLD remains manageable and focused on the essential components needed for the application.
      If the LLD exceeds this limit, prioritize the most critical components and features for the initial version of the application. The application should be planned keeping this limit in mind, and any additional features or components can be considered for future versions or iterations.
  ### Output Structure (Machine-Readable Format for LLM Parsing):
  ### Application Overview
  - Purpose: [Brief app purpose from PRD]
  - Scope:
  - [In-scope PRD feature 1, e.g., "View customer orders"]
  - [In-scope PRD feature 2, e.g., "Edit order status"]
  - Exclusions:
  - [Excluded PRD feature 1, e.g., "Real-time chat (unsupported by low-code platform)"]
  ### UI Components
  - [Component Name, e.g., "Orders Table"]
  - Type: [Widget type, e.g., Data Grid]
  - Data Source: [SQL Query name, e.g., "query_all_orders"]
  - Properties: [e.g., "Columns: ID, Customer, Status"]
  - Events:
  - [Trigger, e.g., "On Edit Button Click"] → [Action, e.g., "Open Edit Form"]
  ### Data Sources & Queries
  - [Query Name, e.g., "query_all_orders"]
  - Type: SQL Query
  - SQL: \`\`\` SELECT order_id, customer_name, order_date, status, total_amount FROM orders 
  JOIN customers ON orders.customer_id = customers.customer_id
  - [Query Name, e.g., "update_order_status"]
  - Type: SQL Query
  - SQL: \`\`\` UPDATE orders SET status = {{form.status_input}} WHERE order_id = {{selected_order_id}}
  - Ensure every table generated has a corresponding query that fetches data for it. This is a mandatory step.
  - Keep queries simple and focused on the data needed for the UI components and general crud operations.
  - When defining a query which will be attached or used in a component property, also include  a description of the query and its purpose. For example, if the query is used to fetch a list of customers, include a description like "This query fetches all customers from the database for the customer dropdown in the form." and a pseudo code of the query.
  - **ENSURE** to create max of 15 queries, ensure only basic queries are created and not complex queries. Queries can not exceed 15 in number.
  Ex: 
   Leave Balance Card
      - Type: Stat Card
      - Data Source: query_employee_leave_balance
        - Description: This query fetches the leave balance for the current employee to display on the dashboard.
        - SQL: \`\`\` SELECT leave_balance FROM employee_leave WHERE employee_id = {{current_employee_id}}
        - Usage {{queries.query_employee_leave_balance[0].leave_balance}}
      - Properties: Display leave balance for current employee
      - Events: None
  

  ### Events & Actions
  - [Event Trigger, e.g., "Save Button Click"]:
  - Actions:
  1. [Action 1, e.g., "Validate required fields"]
  2. [Action 2, e.g., "Run Query: update_order_status"]
  3. [Action 3, e.g., "Show Toast: 'Order updated'"]
  ### Examples (For Clarity):
  ### UI Components
  - Customer Dropdown
  - Type: Dropdown
  - Data Source: query_all_customers
  - Properties: Options mapped to "customer_name" field
  - Events:
  - On Change → Run Query: "query_orders_by_customer"
  ### Data Sources & Queries
  - query_orders_by_customer
  - Type: SQL Query
  - SQL: \`\`\` SELECT order_id, order_date, status, total_amount FROM orders WHERE customer_id = {{customer_dropdown.value}}
  ### Formatting Rules:
  - Use plain text with headers (\`###\`), bullet points (\`-\`), and arrows (\`→\`).
  - Avoid markdown, prose, or tables.
  - Structure all components as key-value pairs for automated parsing.
  - Use SQL for ALL data sources and queries.
  ### Final Checks:
  - Ensure all PRD requirements are either included (if low-code feasible) or explicitly 
  - Feature grouping, since this is a Single page application use tabs to encapsulate features. For example, if the app has a feature to manage users and another to manage orders, create two tabs: "Users" and "Orders". Each tab can then have its own set of components related to that feature. Use container for for general grouping of components. For example, if you have a tab for "User Management", you might have a container for "User List" and another for "User Details". This helps in organizing the components visually and logically.
  - Prioritize simplicity: This is V1, with minimal features and no edge-case handling.
  - Limits: The application should not exceed 50 components, this is a hard rule make the LLD accordingly. ** 50 is a hard limit, architect the application to be in this**
  - Verify all data operations use SQL queries rather than REST endpoints.
  `;
};
