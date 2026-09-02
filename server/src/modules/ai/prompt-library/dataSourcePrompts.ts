const postgresPrompt = `## postgres database ruleset
- For the application which is being generated, queries will be created using postgres datasource.
- Following is how you create queries for the application
    - You have the context of the tables that you are creating and LLD so you can create the queries for the tables.
    - Use the below JSON format for all the queries.
      Rules:
      1. The id should be unique for each query
      2. Add the id mapped with each table column
      3. Set run_on_page_load as true, if the queries needs to be run on application load, else set it as false
    - return the table schema and queries in the below format
        - key queries should hold the array of queries to be created  
        - key tableSchemas should hold the table schema array of tables which need to be created with table_name and columns data, sample data and the order of table creation based on foreign key dependency.
        - ensure the sample data contains all the foreign keys in correct format
        - **ENSURE** to create max of 15 queries, ensure only basic queries are created and not complex queries. Queries can not exceed 15 in number.
        - ** Ensure** the name of table generated has a shortID appended to it. The shortID is a unique identifier for the table and should be in the format of 8 characters. The shortID should be unique for each table and should not be repeated. Ex: bugs_table_12345678. This is MANDATORY and should be followed strictly.
        This is what the output json should look like, **strictly follow this format**. Just give the output in JSON format. Don't start with the word json
{
    "tableSchemas" : [
        {
        "table_creation_order" : 0,
        "table_name": "developer_table",
        "columns": [
            { "name": "id", "type": "INTEGER", "primaryKey": true, "autoIncrement": true },
            { "name": "email", "type": "VARCHAR(100)", "nullable": false, "unique": true },
            { "name": "phone_number", "type": "VARCHAR(20)", "nullable": true },
            { "name": "department", "type": "INTEGER", "nullable": true }
        ],
        "sampleData": [
            { "email": "alice@example.com", "phone_number": "123-456-7890",  "department_id": 1 },
            { "email": "bob@example.com", "phone_number": null, "department_id": 2 },
            { "email": "carol@example.com", "phone_number": "987-654-3210", "department_id": 1 }
        ]
        },
        {
        "table_creation_order" : 1,
        "table_name": "bug_comments",
        "columns": [
            { "name": "id", "type": "SERIAL", "primaryKey": true },
            { "name": "bug_id", "type": "INTEGER", "nullable": false },
            { "name": "developer_id", "type": "INTEGER", "nullable": false, "foreignKey": { "table": "developer_table", "column": "id" } },
            { "name": "comment_text", "type": "TEXT", "nullable": false },
            { "name": "created_at", "type": "TIMESTAMP", "nullable": false }
        ],
        " sampleData": [
            { "id": 1, "bug_id": 101, "developer_id": 201, "comment_text": "Fixed the null pointer issue in the login flow.", "created_at": "2025-06-25 10:15:00" },
            { "id": 2, "bug_id": 102, "developer_id": 202, "comment_text": "Added validation for empty email field.", "created_at": "2025-06-25 11:00:00" },
          ]
        }
    ],
    "queries" : [
        {
            "name": "query_all_bugs",
            "id": "d961d7b6-60bc-4699-a5ce-5c7ec79e3043",
            "tableNames" : ["bugs"],
            "options": {
                "mode": "sql",
                "query": "Select * from bugs where status = '{{components.filter_bugs.label}}'"
            },
            run_on_page_load: false
        },
        {
            "name": "list_all_bugs",
            "id": "t563d7b6-69uc-8376-u9rs-5c74x359e3043",
            "tableNames" : ["bugs","developers"],
            "options": {
                "mode": "sql",
                "query": "SELECT b.id, b.title, b.priority, b.status, d.name as assigned_to, b.created_at FROM bugs b LEFT JOIN developers d ON b.assigned_developer_id = d.id WHERE b.status IN ('Open', 'In Progress') ORDER BY b.created_at DESC"
            },
            run_on_page_load = false
        }
    ]
}
 `;

const tooljetdbPrompt = `## Tooljet database ruleset
- Tooljet Database is a database wrapper over postgres created by tolljet which allows users to create tables and query them using the tooljetdb connector in tooljet
- For the application which is being generated, queries will be created using the tooljetdb.
- Your task is to convert the raw sql queries to tooljetdb queries and generate schema for the table to be created in tooljetdb.
- This is how the schema for a tjdb table will look like
  {"table_name":"test","columns":[{"column_name":"id","data_type":"serial","constraints_type":{"is_primary_key":true,"is_not_null":true,"is_unique":false},"configurations":{}},{"configurations":{},"column_name":"name","data_type":"character varying","constraints_type":{"is_unique":false,"is_primary_key":false}},{"configurations":{},"data_type":"integer","constraints_type":{"is_unique":false,"is_primary_key":false},"column_name":"price"},{"configurations":{},"data_type":"bigint","constraints_type":{"is_unique":false,"is_primary_key":false},"column_name":"amount"},{"configurations":{},"data_type":"double precision","constraints_type":{"is_unique":false,"is_primary_key":false},"column_name":"dollars"},{"configurations":{},"data_type":"boolean","constraints_type":{"is_unique":false,"is_primary_key":false},"column_name":"Flag"},{"configurations":{"timezone":"Asia/Calcutta"},"data_type":"timestamp with time zone","constraints_type":{"is_unique":false,"is_primary_key":false},"column_name":"created_at"}]}
- Following is how you create queries for the TJDB table
    - Make a query having name and columns as tablename you can make any of the 4 operations create_row, list_rows, update_rows and delete_rows. 
    - You have the context of the tables that you are creating and LLD so you can create the queries for the tables.
    - Use the below JSON format for all the 4 operations.
      Rules:
      1. In filter there are 6 operators {"eq":"equals to", "gt": "greater than", "neq"not equal to", "lt": "less than", "lte": "less than equal to", "gte": "greatthan equals to"}
      2. The id should be unique for each filter and should be a number
      3. Table name is the name of the table in the database
      4. components refers to the components available in the app as given above
      4. Add the id mapped with each table column
      Just give the output in JSON format. Don't start with the word json
    - This is what query generated should look like
      {
        "operation": "create_row",
        "component": "tooljetdb",
        "Tablename": "LowStockTable",
        "name": "createLowStock",
        "id": "3df3c11c-5cab-4b65-9a23-3b8d8832d654",
        "create_row": {"0": {"column": "customer_id","value": "{{components.table1.selectedRow.id}}"},"1": {"column": "product_id","value": "{{components.dropdown2.value}}"},"2": {"column": "product_name","value": "{{components.dropdown2.selectedOptionLabel}}"},"3": {"column": "quantity","value": "{{components.dropdown3.value}}"},"5": {"column": "total_price","value": "{{components.textinput18.value}}"}}
      },
      {
        "operation": "list_rows",
        "component": "tooljetdb",
        "Tablename": "sales_analytics_orders",
        "name": "listOrders",
        "id": "3df3c11c-5cab-4b65-9a23-3b8d8832d654",
        "list_rows": {"where_filters": {"23": {"column": "is_active", "operator": "gt", "value": "true", "id": "23"}},"order_filters": {"24": { "column": "id", "order": "desc", "id": "24"}}}
      },
      {
        "operation": "update_rows",
        "component": "tooljetdb",
        "Tablename": "reduceProductQuantity",
        "name": "updateProduct",
        "id": "3df3c11c-5cab-4b65-9a23-3b8d8832d654",
        "update_rows": {"columns": {"47": {"column": "qty_in_stock","value": "{{components.textinput1.value}}"}},"where_filters": {"45": {"column": "id","operator": "eq","value": "{{components.dropdown2.value}}","id": "45"},"46": {"column": "is_active","operator": "eq","value": "true","id": "46"}}}
      {
        "operation": "delete_rows",
        "component": "tooljetdb",
        "Tablename": "deleteProduct",
        "name": "deleteProduct",
        "id": "3df3c11c-5cab-4b65-9a23-3b8d8832d654",
        "delete_rows": {"where_filters": {"51": {"column": "id","operator": "eq","value": "{{components.dropdown2.value}}","id": "51"}}}
      }
      - return the table schema and queries in the below format
        - key tableSchemas should hold the table schema array of tables which need to be created
        - key queries should hold the array of queries to be created
      - if referencing component in query use {{components.component_name.property}} syntax not {{component_name.property}} syntax. ENSURE THIS IS FOLLOWED
      - **ENSURE** to create max of 15 queries, ensure only basic queries are created and not complex queries. Queries can not exceed 15 in number.
      - ** Ensure** the name of table generated has a shortID appended to it. The shortID is a unique identifier for the table and should be in the format of 8 characters. The shortID should be unique for each table and should not be repeated. Ex: bugs_table_12345678. This is MANDATORY and should be followed strictly.
`;

export const dataSourcePrompt = (dataSource) => {
  let prompt;
  if (dataSource.kind == 'tooljetdb') {
    prompt = tooljetdbPrompt;
  } else if (dataSource.kind == 'postgresql') {
    prompt = postgresPrompt;
  }
  return prompt;
};
