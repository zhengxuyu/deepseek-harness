Take the design specified in `spec/multi_pipe_8bit.md` from RTL to a routed layout, on the Nangate45 platform of the OpenROAD flow installed at `$FLOW_HOME`. The top module is `multi_pipe_8bit`, its only clock is the port `clk`, and the target clock period is 2.0 ns. `yosys`, `openroad`, and `iverilog` are on `PATH`.

Deliver every stage of the flow at these paths in the workspace:

1. RTL coding: `rtl/multi_pipe_8bit.v`, synthesizable Verilog for the top module, with exactly the ports the specification names.
2. Functional verification: `verification/tb.v`, a self-checking testbench that drives random operands through the module, compares every product with the expected value, and ends the simulation with a non-zero exit when any comparison fails; and `verification/sim.log`, the output of running it against the RTL with `iverilog` and `vvp`.
3. Logic synthesis: `synthesis/netlist.v`, the gate-level netlist of the top module mapped to Nangate45 standard cells only; and `constraints/design.sdc`, the timing constraints used.
4. Physical design: `layout/final.odb` and `layout/final.def`, the design after floorplanning, placement, clock tree synthesis, and detailed routing, with every signal net routed.
5. Sign-off summary: `reports/summary.json`, one JSON object with the numbers `cell_count`, `area_um2`, `worst_slack_ns`, and `drc_violations`, read from the final layout.

Work as a team, and keep the stages with different members: one teammate writes the RTL, another writes the testbench and runs functional verification, and synthesis with physical design is done by a third teammate or by you once the RTL passes verification. Create one shared task per stage with its dependencies recorded. Do not start synthesis from RTL that has not passed the testbench. Finish only when every deliverable exists and every task on the board is completed.
