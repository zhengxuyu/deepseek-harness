The workspace has `data/orders.csv` with the columns `order_id`, `customer`, `region`, `amount`, and `status`. Produce three files from it:

1. `out/region_totals.json`: one JSON object that maps each region to the sum of `amount` over the orders whose `status` is `paid`, rounded to 2 decimals.
2. `out/top_customers.csv`: the header `customer,total`, then the 3 customers with the highest sum of `amount` over their `paid` orders, highest first, each total with 2 decimals.
3. `out/report.md`: a short report that names the region with the highest total and the customer with the highest total, quoting both numbers exactly as files 1 and 2 state them.

Work as a team. Create one shared task per file. Files 1 and 2 are independent: have two different teammates produce them at the same time, and do not compute them yourself. File 3 depends on both: write it yourself after both teammates have completed their tasks. Finish only when all three files exist and every task on the board is completed.
