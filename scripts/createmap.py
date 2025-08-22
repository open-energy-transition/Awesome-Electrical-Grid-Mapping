import geopandas as gpd
import matplotlib.pyplot as plt
import matplotlib.image as mpimg
from matplotlib.offsetbox import OffsetImage, AnnotationBbox
from PIL import Image
import matplotlib.patches as mpatches

# --- Load your PNG logo ---
logo_img = Image.open("MapYourGrid-logo-and-text.png")

# --- Define brand colors (adjust to match your logo’s palette) ---
brand_colors = ["#1abc9c", "#2c3e50"]  # Example teal & dark blue
color_map = {"Present": brand_colors[0], "Missing": brand_colors[1]}

# --- Provided countries list ---
provided_countries = {
    # Africa (you already had many, keeping them)
    "Somalia", "Morocco", "Nigeria", "Mozambique", "Democratic Republic of the Congo",
    "Ghana", "Angola", "Namibia", "Uganda", "Kenya", "Tanzania", "South Africa",
    "Zambia", "Rwanda", "Ethiopia","Benin","Burkina Faso","Côte d'Ivoire", "Ghana","Guinea",
    "Guinea-Bissau","Liberia","Mali","Niger","Senegal","Sierra Leone","Togo","Gambia","Cameroon",
    "Zimbabwe","Tunisia","Russia",

    # Asia
    "India", "Pakistan", "Sri Lanka", "Japan", "Cambodia", "Indonesia", "Malaysia",
    "Myanmar", "Philippines", "Vietnam", "Nepal", "Turkey", "Georgia", "Jordan",
    "Kazakhstan", "Uzbekistan", "Iran", "Bangladesh", "Mongolia", "South Korea",
    "Tajikistan", "Kyrgyzstan", "Turkmenistan", "Afghanistan", "Papua New Guinea",
    "Laos", "Thailand","Oman","Saudi Arabia","Iraq","Syria","Taiwan","China",

    # Oceania
    "Australia", "New Zealand",

    # Europe
    "United Kingdom", "Germany", "Italy", "Albania", "Spain", "North Macedonia",
    "France", "Bulgaria", "Hungary", "Serbia", "Kosovo", "Lithuania", "Latvia",
    "Estonia", "Belgium", "Bosnia and Herzegovina", "Portugal", "Poland", "Denmark",
    "Austria", "Netherlands", "Ireland", "Greece", "Sweden", "Norway", "Finland",
    "Switzerland", "Romania", "Slovakia", "Czechia", "Iceland","Congo",

    # North America
    "United States", "Canada", "Puerto Rico", "Mexico",

    # Central America & Caribbean
    "Costa Rica", "Nicaragua", "Honduras", "Guatemala", "Cuba","Jamaica",

    # South America
    "Brazil", "Argentina", "Chile", "Bolivia", "Peru", "Uruguay", "Colombia",
    "Ecuador", "Paraguay", "Suriname"
}

# --- Fix mismatched country names ---
name_corrections = {
    "Moçambique": "Mozambique",
    "Democratic Republic of the Congo": "Dem. Rep. Congo",
    "United States": "United States of America",
    "Iran": "Iran, Islamic Rep.",
    "Egypt": "Egypt, Arab Rep.",
    "Bosnia and Herzegovina": "Bosnia and Herz.",
    "Kyrgyzstan": "Kyrgyz Republic",
    "North Macedonia": "Macedonia",
    # Safeguards for other common mismatches
    "Ivory Coast": "Côte d'Ivoire",
    "Swaziland": "Eswatini",
}
provided_countries_corrected = {name_corrections.get(c, c) for c in provided_countries}

# --- Load world map ---
world = gpd.read_file(gpd.datasets.get_path("naturalearth_lowres"))
world["Status"] = world["name"].apply(lambda x: "Present" if x in provided_countries_corrected else "Missing")

# --- Plot map ---
fig, ax = plt.subplots(figsize=(19, 11))
world.plot(
    ax=ax,
    color=world["Status"].map(color_map),
    edgecolor="black",
    linewidth=0.4
)

ax.set_title("Availability of Printed Electrical Grid Maps", fontsize=22, weight="bold", pad=20, color="#1abc9c" )

# Remove axes
ax.axis("off")

# Add a legend manually
import matplotlib.patches as mpatches
legend_patches = [
    mpatches.Patch(color=color_map["Present"], label="Public Electrical Grid Maps"),
    mpatches.Patch(color=color_map["Missing"], label="No Public Grid Maps found so far"),
]
ax.legend(
    handles=legend_patches,
    loc="center",              # anchor point of legend box
    bbox_to_anchor=(0.15, 0.2), # (x, y) position in axes fraction (0=left/bottom, 1=right/top)
    fontsize=12,
    frameon=True
)

# --- Add logo (bottom-right corner) ---
imagebox = OffsetImage(logo_img, zoom=0.2)  # adjust zoom to fit nicely
ab = AnnotationBbox(imagebox, (0.10, 0.32), frameon=False, xycoords='axes fraction')
ax.add_artist(ab)

# --- Save PNG ---
plt.savefig("countries_map_with_logo.png", dpi=300, bbox_inches="tight",transparent=True)